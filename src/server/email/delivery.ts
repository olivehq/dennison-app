import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { emailMessages, type EmailCampaign, type EmailDeliveryEvent, type EmailMessageStatus } from "@/db/schema";
import {
  EmailRejectedError,
  RESEND_BATCH_LIMIT,
  sendBatch,
  type EmailMessage as OutgoingEmail,
  type SentEmail,
} from "@/lib/email/adapter";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";
import { decryptToken, encryptToken } from "@/lib/tokens";
import { recipientKey } from "@/lib/schemas/email";
import { renderEmail } from "./merge";
import type { Recipient } from "./recipients";
import { hashForContact, scheduleHashesForEvent } from "./schedule-hash";

/**
 * Hands a campaign's messages to the email provider in batches and records
 * what happened to each (D185). The first send calls `deliverCampaign`;
 * "Retry delivery" calls `retryRecipients`. Nothing here changes the
 * campaign's status; the caller owns that (`transitionCampaign`).
 *
 * Every batch gets a key, saved on its messages with the hand-off time
 * (`sentAt`) before the provider call, and the provider's idempotency key is
 * derived from it. A batch ends one of three ways:
 *
 * - accepted: the provider took it. Its messages are `sent` and never failed.
 * - rejected: the provider answered no. Its messages are `failed`; a retry
 *   sends new messages under a new key.
 * - uncertain: the call threw without an answer. Its messages stay `queued`
 *   with their hand-off time and key, plus an `unconfirmed` event. A webhook
 *   can still move them on; a retry within `RETRY_WINDOW_HOURS` sends the
 *   same messages under the same key, so the provider sends them at most once.
 */

/** Tries to save a sent batch's provider ids: the first write plus up to three retries. */
export const PROVIDER_ID_WRITE_ATTEMPTS = 4;
const PROVIDER_ID_RETRY_DELAY_MS = 100;

/**
 * How long after its hand-off an uncertain batch may be retried under its
 * key. Resend keeps an idempotency key for 24 hours; after that a retry could
 * send twice, so the message is left alone, as before D185.
 */
export const RETRY_WINDOW_HOURS = 23;

/** The provider's idempotency key for a batch. */
export function idempotencyKey(batchKey: string): string {
  return `aw-batch/${batchKey}`;
}

export type Delivered = {
  /** Messages the provider accepted. */
  sent: number;
  /** Messages that did not go: the provider refused them, or they were never handed over. */
  failed: number;
  /** Messages in a batch with no answer from the provider: they may have gone. */
  uncertain: number;
  /** Messages the provider accepted whose provider ids could not be saved (D95). */
  sentWithoutIds: number;
  providerIdError?: string;
  /**
   * Messages whose final status could not be saved either. They stay `queued`
   * with their hand-off time and key, as uncertain ones do.
   */
  statusNotSaved: number;
  statusError?: string;
};

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

/** What the audit row says about batches without a clear answer and writes that failed, if any. */
export function deliveryProblems(d: Delivered) {
  return {
    ...(d.uncertain > 0 ? { uncertain: d.uncertain } : {}),
    ...(d.sentWithoutIds > 0 ? { sentWithoutIds: d.sentWithoutIds, providerIdError: d.providerIdError } : {}),
    ...(d.statusNotSaved > 0 ? { statusNotSaved: d.statusNotSaved, statusError: d.statusError } : {}),
  };
}

/** Statuses "Retry delivery" retries: the message never reached the person. */
export const RESENDABLE_STATUSES: readonly EmailMessageStatus[] = ["bounced", "failed"];

type MessageState = { status: EmailMessageStatus; sentAt: Date | null; batchKey: string | null };

/** Queued, handed over under a key, and still inside the window where a retry under that key is safe. */
function isRetryableUncertain(message: MessageState, now: Date): message is MessageState & { sentAt: Date; batchKey: string } {
  return (
    message.status === "queued" &&
    message.sentAt !== null &&
    message.batchKey !== null &&
    now.getTime() - message.sentAt.getTime() < RETRY_WINDOW_HOURS * 60 * 60 * 1000
  );
}

/**
 * True when "Retry delivery" may send this message's recipient the
 * campaign again: it bounced or failed; or it is queued and was never handed
 * to the provider (no `sentAt`); or its batch had no answer and can still be
 * retried under the same key. Any other queued message with a hand-off time
 * may have been accepted, so it is never sent again.
 */
export function isResendable(message: MessageState, now: Date = new Date()): boolean {
  return (
    RESENDABLE_STATUSES.includes(message.status) ||
    (message.status === "queued" && message.sentAt === null) ||
    isRetryableUncertain(message, now)
  );
}

/** A message row ready for the provider, with the values to render it. */
type Outgoing = { id: string; toEmail: string; recipient: Recipient };

type Run = {
  db: Db;
  campaign: EmailCampaign;
  result: Delivered;
  compose: (message: Outgoing) => OutgoingEmail;
  log: (message: string) => void;
};

function startRun(db: Db, campaign: EmailCampaign): Run {
  const from = `${campaign.fromName} <${campaign.fromEmail}>`;
  const safeBody = sanitizeEmailHtml(campaign.htmlBody);
  return {
    db,
    campaign,
    result: { sent: 0, failed: 0, uncertain: 0, sentWithoutIds: 0, statusNotSaved: 0 },
    compose: (message) => ({
      to: message.toEmail,
      from,
      replyTo: campaign.replyTo,
      ...renderEmail(campaign.subject, safeBody, message.recipient.mergeValues),
      // Lets the webhook find the message even before its provider id is saved.
      tags: { aw_message: message.id },
    }),
    log: (message) => console.error(`[email] campaign ${campaign.id}: ${message}`),
  };
}

/**
 * Writes one queued message per recipient, with the hash of the schedule it
 * describes, then sends them in new batches of up to 100. A batch whose
 * hand-off time and key can't be saved is not sent, so a queued message
 * without `sentAt` was never handed over. No database error after the insert
 * stops the loop: it is counted and logged.
 */
export async function deliverCampaign(db: Db, campaign: EmailCampaign, recipients: Recipient[]): Promise<Delivered> {
  const run = startRun(db, campaign);
  await sendNew(run, recipients);
  return run.result;
}

/**
 * Sends the campaign again to these recipients. One whose newest message is
 * uncertain and inside `RETRY_WINDOW_HOURS` has its whole original batch
 * resent as it was first handed over (same emails, same order, same key), so
 * the provider sends it at most once even if a link or address changed since.
 * One whose newest message is no longer resendable (a webhook moved it on) is
 * skipped. The rest get new messages in new batches at their current address.
 */
export async function retryRecipients(
  db: Db,
  campaign: EmailCampaign,
  recipients: Recipient[],
  now: Date = new Date(),
): Promise<Delivered> {
  const run = startRun(db, campaign);
  const latest = await db
    .selectDistinctOn([emailMessages.contactType, emailMessages.entityId], {
      id: emailMessages.id,
      contactType: emailMessages.contactType,
      entityId: emailMessages.entityId,
      toEmail: emailMessages.toEmail,
      status: emailMessages.status,
      sentAt: emailMessages.sentAt,
      batchKey: emailMessages.batchKey,
    })
    .from(emailMessages)
    .where(eq(emailMessages.campaignId, campaign.id))
    .orderBy(emailMessages.contactType, emailMessages.entityId, desc(emailMessages.createdAt));
  const newest = new Map(latest.map((m) => [recipientKey(m.contactType, m.entityId), m]));

  const again = new Set<string>();
  const fresh: Recipient[] = [];
  for (const recipient of recipients) {
    const message = newest.get(recipient.key);
    if (!message) fresh.push(recipient);
    else if (isRetryableUncertain(message, now)) again.add(message.batchKey);
    // Read again here, not trusted from the caller: a webhook may have moved it
    // on since, and a delivered message must never be sent a second time.
    else if (isResendable(message, now)) fresh.push(recipient);
  }
  for (const batchKey of again) await retryBatch(run, batchKey);
  await sendNew(run, fresh);
  return run.result;
}

async function sendNew(run: Run, recipients: Recipient[]): Promise<void> {
  if (recipients.length === 0) return;
  const { db, campaign, result } = run;
  const hashes = await scheduleHashesForEvent(db, campaign.eventId);
  const rows = await db.transaction(async (tx) =>
    tx
      .insert(emailMessages)
      .values(
        recipients.map((r) => ({
          campaignId: campaign.id,
          eventId: campaign.eventId,
          accessTokenId: r.tokenId,
          contactType: r.contactType,
          entityId: r.entityId,
          recipientName: r.name,
          toEmail: r.email,
          scheduleHash: hashForContact(hashes, r.contactType, r.entityId),
        })),
      )
      .returning({ id: emailMessages.id }),
  );

  for (let start = 0; start < recipients.length; start += RESEND_BATCH_LIMIT) {
    const messages = recipients
      .slice(start, start + RESEND_BATCH_LIMIT)
      .map((recipient, i) => ({ id: rows[start + i].id, toEmail: recipient.email, recipient }));
    const ids = messages.map((m) => m.id);
    const batchKey = randomUUID();
    const emails = messages.map(run.compose);
    try {
      await db
        .update(emailMessages)
        .set({ sentAt: new Date(), batchKey, request: byId(ids, emails.map((email, index) => encryptToken(JSON.stringify({ index, email })))) })
        .where(inArray(emailMessages.id, ids));
    } catch (error) {
      // Not sent: without the hand-off time and key a retry could mail them twice.
      result.failed += ids.length;
      run.log(`a batch of ${ids.length} was not sent because the database could not record it: ${errorText(error)}`);
      continue;
    }
    await sendInBatch(run, batchKey, ids, emails);
  }
}

/** A `case id when ... then ... end` that gives each message its own text value in one UPDATE. */
function byId(ids: string[], values: string[]) {
  return sql`(${sql.join(
    [sql`case ${emailMessages.id}`, ...ids.map((id, i) => sql`when ${id}::uuid then ${values[i]}::text`), sql`end`],
    sql` `,
  )})`;
}

/**
 * Resends an uncertain batch exactly as it was first handed over, under its
 * key. A message of the batch that a webhook already moved on proves the
 * provider took the batch, so its queued messages are marked sent instead.
 */
async function retryBatch(run: Run, batchKey: string): Promise<void> {
  const { db, campaign, result } = run;
  const batch = await db
    .select({ id: emailMessages.id, status: emailMessages.status, request: emailMessages.request })
    .from(emailMessages)
    .where(and(eq(emailMessages.campaignId, campaign.id), eq(emailMessages.batchKey, batchKey)));
  const queued = batch.filter((m) => m.status === "queued").map((m) => m.id);
  if (queued.length < batch.length) {
    result.sent += queued.length;
    try {
      await db
        .update(emailMessages)
        .set({ status: "sent", request: null })
        .where(and(inArray(emailMessages.id, queued), eq(emailMessages.status, "queued")));
    } catch (error) {
      statusNotSaved(run, queued, error);
    }
    return;
  }
  // `request` is written in the same UPDATE as `batchKey` and cleared only once the batch has an answer.
  const plain = batch.map((m) => (m.request ? decryptToken(m.request) : null));
  if (plain.some((p) => p === null)) {
    // Unreadable (for example TOKEN_PEPPER changed): a rebuilt batch could differ, so it stays uncertain.
    result.uncertain += batch.length;
    run.log(`a batch of ${batch.length} could not be retried: its saved request is unreadable.`);
    return;
  }
  const stored = batch
    .map((m, i) => ({ id: m.id, ...(JSON.parse(plain[i]!) as { index: number; email: OutgoingEmail }) }))
    .sort((a, b) => a.index - b.index);
  await sendInBatch(run, batchKey, stored.map((m) => m.id), stored.map((m) => m.email), { retry: true });
}

function statusNotSaved(run: Run, ids: string[], error: unknown) {
  run.result.statusNotSaved += ids.length;
  run.result.statusError = errorText(error);
  run.log(`the status of ${ids.length} messages was not saved, so they stay queued: ${run.result.statusError}`);
}

/** One provider call under the batch's key, and the outcome written to its messages. */
async function sendInBatch(
  run: Run,
  batchKey: string,
  ids: string[],
  emails: OutgoingEmail[],
  { retry = false }: { retry?: boolean } = {},
): Promise<void> {
  let accepted: SentEmail[];
  try {
    accepted = await sendBatch(emails, { idempotencyKey: idempotencyKey(batchKey) });
  } catch (error) {
    // Only a first attempt can prove a refusal. A retry may be refused before the
    // provider looks at the key (a rotated API key), while the first attempt went.
    if (error instanceof EmailRejectedError && !retry) await markRejected(run, ids, error);
    else await markUncertain(run, ids, error);
    return;
  }
  await markAccepted(run, ids, accepted);
}

/** Appends an event to the batch's messages that are still queued and sets their status. */
function appendEvent(db: Db, ids: string[], event: EmailDeliveryEvent, status?: EmailMessageStatus) {
  return db
    .update(emailMessages)
    .set({
      // A refused batch is never retried under its key, so its saved request goes.
      ...(status ? { status, sentAt: null, request: null } : {}),
      events: sql`${emailMessages.events} || ${JSON.stringify([event])}::jsonb`,
      lastEventAt: new Date(event.at),
    })
    .where(and(inArray(emailMessages.id, ids), eq(emailMessages.status, "queued")));
}

async function markRejected(run: Run, ids: string[], error: unknown) {
  const event: EmailDeliveryEvent = { type: "failed", at: new Date().toISOString(), detail: errorText(error) };
  run.result.failed += ids.length;
  run.log(`a batch of ${ids.length} was not sent: ${event.detail}`);
  try {
    await appendEvent(run.db, ids, event, "failed");
  } catch (writeError) {
    // Still queued with the hand-off time and key: a retry under the key is safe.
    statusNotSaved(run, ids, writeError);
  }
}

async function markUncertain(run: Run, ids: string[], error: unknown) {
  const event: EmailDeliveryEvent = { type: "unconfirmed", at: new Date().toISOString(), detail: errorText(error) };
  run.result.uncertain += ids.length;
  run.log(`a batch of ${ids.length} got no answer from the provider, so it may have gone: ${event.detail}`);
  try {
    await appendEvent(run.db, ids, event);
  } catch (writeError) {
    // The hand-off time and key are already saved, which is all a retry needs.
    run.log(`could not note the missing answer on ${ids.length} messages: ${errorText(writeError)}`);
  }
}

/** One UPDATE for the batch: provider ids, `sent` unless a webhook already moved it on, and the send time. */
async function saveProviderIds(db: Db, ids: string[], providerIds: (string | null)[], sentAt: Date): Promise<void> {
  const providerId = sql.join(
    [
      sql`case ${emailMessages.id}`,
      ...ids.map((id, i) => sql`when ${id}::uuid then ${providerIds[i] ?? null}::text`),
      sql`end`,
    ],
    sql` `,
  );
  await db
    .update(emailMessages)
    .set({
      providerMessageId: providerId,
      // A webhook matched by tag may already have moved it past sent.
      status: sql`case when ${emailMessages.status} = 'queued' then 'sent'::email_message_status else ${emailMessages.status} end`,
      sentAt,
      // Accepted: never retried, so the saved request (it holds schedule links) goes.
      request: null,
    })
    .where(inArray(emailMessages.id, ids));
}

/**
 * The provider accepted the batch: from here on these messages are sent. If
 * the provider ids can't be saved after retries, the messages become `sent`
 * without ids (D95); webhooks still find them by their `aw_message` tag (D63).
 */
async function markAccepted(run: Run, ids: string[], accepted: SentEmail[]) {
  const { db, result } = run;
  result.sent += ids.length;
  const sentAt = new Date();
  const providerIds = ids.map((_, i) => accepted[i]?.id ?? null);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= PROVIDER_ID_WRITE_ATTEMPTS; attempt++) {
    try {
      await saveProviderIds(db, ids, providerIds, sentAt);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < PROVIDER_ID_WRITE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_ID_RETRY_DELAY_MS * attempt));
      }
    }
  }
  result.sentWithoutIds += ids.length;
  result.providerIdError = errorText(lastError);
  run.log(`a batch of ${ids.length} was sent but its provider ids were not saved: ${result.providerIdError}`);
  try {
    await db
      .update(emailMessages)
      .set({
        status: sql`case when ${emailMessages.status} = 'queued' then 'sent'::email_message_status else ${emailMessages.status} end`,
        sentAt,
        request: null,
      })
      .where(inArray(emailMessages.id, ids));
  } catch (writeError) {
    statusNotSaved(run, ids, writeError);
  }
}
