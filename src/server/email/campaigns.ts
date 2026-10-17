import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  admins,
  emailCampaigns,
  emailMessages,
  events,
  type EmailCampaign,
  type EmailCampaignKind,
  type EmailDeliveryEvent,
  type EmailMessageStatus,
  type Event,
} from "@/db/schema";
import { isEmailConfigured, sendBatch, sendEmail, type EmailMessage as OutgoingEmail } from "@/lib/email/adapter";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";
import { env } from "@/lib/env";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { eventAllows } from "@/lib/event-gates";
import { campaignFieldsSchema, recipientKey, type CampaignFieldsInput, type EmailAudience } from "@/lib/schemas/email";
import { recordAudit } from "@/server/audit/audit";
import { claimEvent, inEventTransaction, Refused } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { advanceStatus } from "@/server/events/status";
import { findUnknownFields, renderTemplate, renderText, SAMPLE_MERGE_VALUES, type MergeValues } from "./merge";
import { audienceContactsFor, listAudienceContacts, resolveAudience, withLinks, type Recipient } from "./recipients";
import { hashForContact, scheduleHashesForEvent } from "./schedule-hash";

/**
 * Campaigns: create, edit while draft, duplicate, preview, test, send, and
 * resend to bounced (scope 2.7). Every send goes through the email adapter;
 * nothing here logs a message body.
 */

/** Resend's batch API takes at most 100 messages per call. */
export const SEND_CHUNK_SIZE = 100;


export const NOT_LOCKED_MESSAGE = "Lock the schedule before sending so every link is final.";

/** Why someone with a revoked link got nothing, and what to do. */
export const REGENERATE_HINT = "Use Regenerate on the roster to give someone a new link.";

export const EMAIL_NOT_CONFIGURED_MESSAGE = "Email is not configured for this deployment. Add RESEND_API_KEY.";

/**
 * In production the logger adapter would "send" to the server log and mark
 * every message sent, so a campaign refuses instead. Tests pass `isProduction`.
 */
function emailNotConfigured(isProduction: boolean): boolean {
  return isProduction && !isEmailConfigured();
}

export const TEST_NO_API_KEY_MESSAGE =
  "The test email was not sent: this deployment has no RESEND_API_KEY, so it can't send mail. Add RESEND_API_KEY in the Vercel project settings (Environment Variables) and redeploy.";

export const TEST_EXAMPLE_SENDER_MESSAGE =
  "The test email was not sent: the From email is on example.com, which no mail provider will send from. Verify your sending domain in Resend, then change the From email on this campaign to an address on it. Set EMAIL_FROM in Vercel so new campaigns start with it.";

/** True for example.com, example.org, example.net, and their subdomains: reserved names nobody can verify. */
function isExampleDomain(address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
  return /(^|\.)example\.(com|org|net)$/.test(domain);
}

/**
 * Why a test email can't really be delivered from this deployment, or null.
 * Only production refuses: in development the logger adapter is expected.
 */
function testSendProblem(isProduction: boolean, fromEmail: string): string | null {
  if (!isProduction) return null;
  if (!isEmailConfigured()) return TEST_NO_API_KEY_MESSAGE;
  if (isExampleDomain(fromEmail)) return TEST_EXAMPLE_SENDER_MESSAGE;
  return null;
}

export const DEFAULT_SUBJECTS: Record<EmailCampaignKind, string> = {
  initial: "Your appointment schedule for {{event_name}}",
  reminder: "Reminder: your appointment schedule for {{event_name}}",
  update: "Your {{event_name}} schedule has changed",
};

export const DEFAULT_BODIES: Record<EmailCampaignKind, string> = {
  initial:
    "<p>Hi {{first_name}},</p><p>Your appointment schedule for {{event_name}} on {{event_date}} is ready. Open it here: {{schedule_link}}</p><p>The link is private to you. Reply to this email if anything looks wrong.</p>",
  reminder:
    "<p>Hi {{first_name}},</p><p>A reminder that {{event_name}} is on {{event_date}}. Your schedule: {{schedule_link}}</p>",
  update:
    "<p>Hi {{first_name}},</p><p>Your AW appointment schedule has changed. Open your updated schedule: {{schedule_link}}</p>",
};

const DEFAULT_NAMES: Record<EmailCampaignKind, string> = {
  initial: "Schedule email",
  reminder: "Reminder",
  update: "Schedule update",
};

/** "AW Appointment Show <schedule@example.com>" -> name and address. */
export function parseSender(value: string): { fromName: string; fromEmail: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { fromName: match[1].trim() || match[2].trim(), fromEmail: match[2].trim() };
  return { fromName: value.trim(), fromEmail: value.trim() };
}

async function loadCampaign(db: Db, campaignId: string): Promise<EmailCampaign | null> {
  const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
  return row ?? null;
}

const ARCHIVED_MESSAGE = "This event is archived.";

/** The refusal for a missing or archived event, else null. A read without a lock: the early answer before any work. */
async function refuseArchived(db: Db, eventId: string): Promise<ActionResult<never> | null> {
  const event = await getEvent(eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status === "archived") return fail("locked", ARCHIVED_MESSAGE);
  return null;
}

function campaignSnapshot(c: EmailCampaign) {
  return {
    name: c.name,
    kind: c.kind,
    audience: c.audience,
    subject: c.subject,
    fromEmail: c.fromEmail,
    replyTo: c.replyTo,
    selectedCount: c.selectedRecipients.length,
  };
}

// ---------------------------------------------------------------------------
// Create, edit, duplicate
// ---------------------------------------------------------------------------

/** Sender fields for a new campaign: the event's newest campaign, else EMAIL_FROM and the admin's address. */
async function senderDefaults(db: Db, eventId: string, adminId: string) {
  const [latest] = await db
    .select({ fromName: emailCampaigns.fromName, fromEmail: emailCampaigns.fromEmail, replyTo: emailCampaigns.replyTo })
    .from(emailCampaigns)
    .where(eq(emailCampaigns.eventId, eventId))
    .orderBy(desc(emailCampaigns.createdAt))
    .limit(1);
  if (latest) return latest;
  const [admin] = await db.select({ email: admins.email }).from(admins).where(eq(admins.id, adminId)).limit(1);
  return { ...parseSender(env.EMAIL_FROM), replyTo: admin?.email ?? "" };
}

/**
 * A new draft with default copy. `update` drafts go to the people whose
 * schedule changed since their last email (scope 2.7).
 */
export async function createCampaign(
  db: Db,
  input: { eventId: string; adminId: string; kind?: "initial" | "update" },
): Promise<ActionResult<EmailCampaign>> {
  const archived = await refuseArchived(db, input.eventId);
  if (archived) return archived;
  const kind = input.kind ?? "initial";
  // Campaign writes claim the event row while it is not archived (D89), so an
  // archive that lands after `refuseArchived` waits for this or makes it the conflict.
  return inEventTransaction(db, input.eventId, "unarchived", async (tx) => {
    const sender = await senderDefaults(tx, input.eventId, input.adminId);
    const [row] = await tx
      .insert(emailCampaigns)
      .values({
        eventId: input.eventId,
        name: DEFAULT_NAMES[kind],
        ...sender,
        subject: DEFAULT_SUBJECTS[kind],
        htmlBody: DEFAULT_BODIES[kind],
        audience: kind === "update" ? "changed_since_last_send" : "all",
        kind,
        createdBy: input.adminId,
      })
      .returning();
    await recordAudit(tx, {
      eventId: input.eventId,
      adminId: input.adminId,
      action: "email.create",
      entityType: "email_campaign",
      entityId: row.id,
      after: campaignSnapshot(row),
    });
    return row;
  });
}

/** Saves the editor. Only drafts can change; a sent campaign is a record. */
export async function updateCampaign(
  db: Db,
  input: { campaignId: string; adminId: string; fields: CampaignFieldsInput },
): Promise<ActionResult<EmailCampaign>> {
  const parsed = campaignFieldsSchema.safeParse(input.fields);
  if (!parsed.success) return fromZod(parsed.error);
  const campaign = await loadCampaign(db, input.campaignId);
  if (!campaign) return fail("not_found", "That campaign no longer exists.");
  const archived = await refuseArchived(db, campaign.eventId);
  if (archived) return archived;
  if (campaign.status !== "draft") return fail("conflict", "This campaign was already sent and can't be edited. Duplicate it instead.");
  const fields = parsed.data;
  return inEventTransaction(db, campaign.eventId, "unarchived", async (tx) => {
    const [row] = await tx
      .update(emailCampaigns)
      .set({
        ...fields,
        // Stored as typed in HTML mode, but cleaned: no scripts, handlers, or unsafe styles.
        htmlBody: sanitizeEmailHtml(fields.htmlBody),
        selectedRecipients: fields.audience === "selected" ? fields.selectedRecipients : [],
      })
      .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, "draft")))
      .returning();
    if (!row) throw new Refused(fail("conflict", "This campaign was sent while you were editing."));
    await recordAudit(tx, {
      eventId: campaign.eventId,
      adminId: input.adminId,
      action: "email.update",
      entityType: "email_campaign",
      entityId: campaign.id,
      before: campaignSnapshot(campaign),
      after: campaignSnapshot(row),
    });
    return row;
  });
}

/**
 * A new draft from an existing campaign. `reminder` keeps the copy and the
 * audience for editing; `update` switches to the default update body and the
 * people whose schedule changed.
 */
export async function duplicateCampaign(
  db: Db,
  input: { campaignId: string; adminId: string; kind: "reminder" | "update" },
): Promise<ActionResult<EmailCampaign>> {
  const source = await loadCampaign(db, input.campaignId);
  if (!source) return fail("not_found", "That campaign no longer exists.");
  const archived = await refuseArchived(db, source.eventId);
  if (archived) return archived;
  const isUpdate = input.kind === "update";
  return inEventTransaction(db, source.eventId, "unarchived", async (tx) => {
    const [row] = await tx
      .insert(emailCampaigns)
      .values({
        eventId: source.eventId,
        name: isUpdate ? DEFAULT_NAMES.update : `${source.name} (reminder)`,
        fromName: source.fromName,
        fromEmail: source.fromEmail,
        replyTo: source.replyTo,
        subject: isUpdate ? DEFAULT_SUBJECTS.update : source.subject,
        htmlBody: isUpdate ? DEFAULT_BODIES.update : source.htmlBody,
        audience: isUpdate ? "changed_since_last_send" : source.audience,
        selectedRecipients: isUpdate ? [] : source.selectedRecipients,
        kind: input.kind,
        createdBy: input.adminId,
      })
      .returning();
    await recordAudit(tx, {
      eventId: source.eventId,
      adminId: input.adminId,
      action: "email.duplicate",
      entityType: "email_campaign",
      entityId: row.id,
      after: { ...campaignSnapshot(row), sourceId: source.id },
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Preview and test
// ---------------------------------------------------------------------------

export type RenderedEmail = {
  recipient: { key: string; name: string; email: string } | null;
  subject: string;
  html: string;
  unknownFields: string[];
};

/** Wraps the body so every client gets a readable default font. */
export function emailDocument(bodyHtml: string): string {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.5; color: #1f1a17;">${bodyHtml}</div>`;
}

type AudienceChoice = { audience: EmailAudience; selectedRecipients: string[] };

/**
 * One contact's merge values without writing anything: the chosen contact if
 * given, else the first of the audience (the editor's unsaved one when
 * passed, else the saved one), else anyone, else sample values.
 */
async function sampleRecipient(
  db: Db,
  campaign: EmailCampaign,
  key: string | undefined,
  audienceChoice: AudienceChoice = campaign,
): Promise<ActionResult<{ recipient: Recipient | null; values: MergeValues }>> {
  const contacts = await listAudienceContacts(db, campaign.eventId);
  if (!contacts) return fail("not_found", "That event no longer exists.");
  let chosen = key ? contacts.find((c) => c.key === key) : undefined;
  if (key && !chosen) return fail("not_found", "That recipient is no longer on the roster.");
  if (!chosen) {
    // Pick the person from the contacts already loaded; only they get a link resolved.
    const inAudience = await audienceContactsFor(db, campaign.eventId, contacts, audienceChoice.audience, audienceChoice.selectedRecipients);
    chosen = inAudience[0] ?? contacts[0];
  }
  if (!chosen) return ok({ recipient: null, values: SAMPLE_MERGE_VALUES });
  const withLink = await withLinks(db, campaign.eventId, [chosen], "existing");
  if (!withLink.ok) return withLink;
  const recipient = withLink.data[0];
  return ok({ recipient, values: recipient.mergeValues });
}

/**
 * Merges one recipient's values into a subject and an already sanitized body.
 * The body is sanitized before merging, so a stored body from before the
 * sanitizer, or an unsaved preview, is cleaned too; merged values are escaped.
 */
function render(subject: string, safeBody: string, values: MergeValues): { subject: string; html: string } {
  return { subject: renderText(subject, values), html: emailDocument(renderTemplate(safeBody, values)) };
}

/**
 * Subject and body as one recipient will see them. Pass `subject`/`htmlBody`
 * to preview unsaved edits, and `audience`/`selectedRecipients` so the
 * default recipient comes from the unsaved audience.
 */
export async function previewCampaign(
  db: Db,
  input: {
    campaignId: string;
    recipient?: string;
    subject?: string;
    htmlBody?: string;
    audience?: EmailAudience;
    selectedRecipients?: string[];
  },
): Promise<ActionResult<RenderedEmail>> {
  const campaign = await loadCampaign(db, input.campaignId);
  if (!campaign) return fail("not_found", "That campaign no longer exists.");
  const sample = await sampleRecipient(db, campaign, input.recipient, {
    audience: input.audience ?? campaign.audience,
    selectedRecipients: input.selectedRecipients ?? (input.audience ? [] : campaign.selectedRecipients),
  });
  if (!sample.ok) return sample;
  const subject = input.subject ?? campaign.subject;
  const htmlBody = input.htmlBody ?? campaign.htmlBody;
  const safeBody = sanitizeEmailHtml(htmlBody);
  const r = sample.data.recipient;
  return ok({
    recipient: r ? { key: r.key, name: r.name, email: r.email } : null,
    ...render(subject, safeBody, sample.data.values),
    unknownFields: findUnknownFields(`${subject} ${htmlBody}`),
  });
}

export const TEST_SEND_ADMINS_ONLY = "Test emails go only to active admins. Use your own address or a colleague's from the Team page.";

/** What a Resend rejection usually means, added to its own message so the admin knows what to do. */
function resendHint(message: string): string {
  return /domain|verif/i.test(message) ? " Verify the sending domain in Resend, and send from an address on it." : "";
}

export type TestSendResult = {
  toEmail: string;
  recipientName: string | null;
  /** False when the logger adapter took it (no RESEND_API_KEY, development): nothing left the server. */
  delivered: boolean;
};

export const TEST_DRAFT_ONLY = "This campaign is being sent or was already sent, so it can't be tested. Duplicate it to test a copy.";

/**
 * Sends the saved draft to one active admin's address with a sample
 * recipient's values. Production refuses, with the reason, when mail can't
 * really go out (no API key, or an example.com sender); a "sent" toast there
 * would be a lie.
 *
 * The email goes out before any row is locked, so no lock is held across the
 * provider call. The record (`testSentAt`, audit) is written afterwards in a
 * transaction that claims the event row first, the order every campaign
 * transaction uses (event, then campaign).
 */
export async function sendTest(
  db: Db,
  input: { campaignId: string; toEmail: string; adminId: string; recipient?: string },
  options: { isProduction?: boolean } = {},
): Promise<ActionResult<TestSendResult>> {
  const campaign = await loadCampaign(db, input.campaignId);
  if (!campaign) return fail("not_found", "That campaign no longer exists.");
  const archived = await refuseArchived(db, campaign.eventId);
  if (archived) return archived;
  if (campaign.status !== "draft") return fail("conflict", TEST_DRAFT_ONLY);
  const problem = testSendProblem(options.isProduction ?? env.isProduction, campaign.fromEmail);
  if (problem) return fail("internal", problem);
  // A test carries a real participant's link and merge values, so it may only
  // go to someone who could see them in the app anyway.
  const [admin] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(and(sql`lower(${admins.email}) = ${input.toEmail.trim().toLowerCase()}`, isNull(admins.disabledAt)))
    .limit(1);
  if (!admin) return fail("validation", TEST_SEND_ADMINS_ONLY, { toEmail: [TEST_SEND_ADMINS_ONLY] });
  const sample = await sampleRecipient(db, campaign, input.recipient);
  if (!sample.ok) return sample;
  const rendered = render(campaign.subject, sanitizeEmailHtml(campaign.htmlBody), sample.data.values);
  const delivered = isEmailConfigured();
  try {
    await sendEmail({
      to: input.toEmail,
      from: `${campaign.fromName} <${campaign.fromEmail}>`,
      replyTo: campaign.replyTo,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      tags: { aw_kind: "test" },
    });
  } catch (error) {
    const reason = errorText(error);
    return fail("internal", `The test email was not sent: ${reason}${resendHint(reason)}`);
  }
  const result = { toEmail: input.toEmail, recipientName: sample.data.recipient?.name ?? null, delivered };
  return db.transaction(async (tx) => {
    if (!(await claimEvent(tx, campaign.eventId, "unarchived"))) {
      // Archived while the test went out. The admin did get it, but an
      // archived event takes no writes, so nothing is recorded.
      console.warn(`[email] campaign ${campaign.id}: test sent, not recorded because the event was archived meanwhile.`);
      return ok(result);
    }
    // A logged test never reached an inbox, so it doesn't count as "test sent".
    // A campaign sent meanwhile keeps its record as it is.
    if (delivered) {
      await tx
        .update(emailCampaigns)
        .set({ testSentAt: new Date() })
        .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, "draft")));
    }
    await recordAudit(tx, {
      eventId: campaign.eventId,
      adminId: input.adminId,
      action: "email.test",
      entityType: "email_campaign",
      entityId: campaign.id,
      after: { toEmail: input.toEmail, recipient: sample.data.recipient?.key ?? null, delivered },
    });
    return ok(result);
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SendResult = {
  campaignId: string;
  eventId: string;
  recipients: number;
  sent: number;
  failed: number;
  /** Left out because their newest link was revoked; Regenerate on the roster gives them a new one. */
  skippedRevoked: number;
  eventAdvanced: boolean;
  /** False when the logger adapter took the messages (no RESEND_API_KEY, development): nothing left the server. */
  delivered: boolean;
};

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

/** Tries to save a sent chunk's provider ids: the first write plus up to three retries. */
export const PROVIDER_ID_WRITE_ATTEMPTS = 4;
const PROVIDER_ID_RETRY_DELAY_MS = 100;

type Delivered = {
  sent: number;
  failed: number;
  /** Messages the provider accepted whose provider ids could not be saved (D95). */
  sentWithoutIds: number;
  providerIdError?: string;
  /**
   * Messages whose final status could not be saved either. They stay `queued`
   * with their hand-off time, so "Resend to bounced" leaves them alone.
   */
  statusNotSaved: number;
  statusError?: string;
};

/** One UPDATE for the chunk: provider ids, `sent` unless a webhook already moved it on, and the send time. */
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
    })
    .where(inArray(emailMessages.id, ids));
}

/**
 * Writes one queued message per recipient with the hash of the schedule it
 * describes, then sends in chunks of 100. Before a chunk goes to the provider
 * its messages get `sentAt` (the hand-off time) while still `queued`; a chunk
 * whose hand-off time can't be saved is not sent. So a queued message with no
 * `sentAt` was never handed over and is safe to send again, and one with a
 * `sentAt` may have been accepted and never is (`isResendable`).
 *
 * A chunk the provider refuses is marked failed; the rest still go. A chunk
 * the provider accepted is never marked failed: if its provider ids can't be
 * saved after retries, its messages become `sent` without ids (D95). No
 * database error after the first insert stops the loop: it is counted and
 * logged, and the campaign ends sent or failed on what the provider did.
 */
async function deliver(db: Db, campaign: EmailCampaign, recipients: Recipient[]): Promise<Delivered> {
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

  const from = `${campaign.fromName} <${campaign.fromEmail}>`;
  const safeBody = sanitizeEmailHtml(campaign.htmlBody);
  const result: Delivered = { sent: 0, failed: 0, sentWithoutIds: 0, statusNotSaved: 0 };
  const log = (message: string) => console.error(`[email] campaign ${campaign.id}: ${message}`);
  const statusNotSaved = (ids: string[], error: unknown) => {
    result.statusNotSaved += ids.length;
    result.statusError = errorText(error);
    log(`the status of ${ids.length} messages was not saved, so they stay queued: ${result.statusError}`);
  };

  for (let start = 0; start < recipients.length; start += SEND_CHUNK_SIZE) {
    const chunk = recipients.slice(start, start + SEND_CHUNK_SIZE);
    const ids = rows.slice(start, start + SEND_CHUNK_SIZE).map((r) => r.id);
    try {
      await db.update(emailMessages).set({ sentAt: new Date() }).where(inArray(emailMessages.id, ids));
    } catch (error) {
      // Not sent: without the hand-off time a later failure could mail them twice.
      result.failed += ids.length;
      log(`a batch of ${ids.length} was not sent because the database could not record it: ${errorText(error)}`);
      continue;
    }
    const outgoing: OutgoingEmail[] = chunk.map((r, i) => ({
      to: r.email,
      from,
      replyTo: campaign.replyTo,
      ...render(campaign.subject, safeBody, r.mergeValues),
      // Lets the webhook find the message even before its provider id is saved.
      tags: { aw_message: ids[i] },
    }));
    let results: Awaited<ReturnType<typeof sendBatch>>;
    try {
      results = await sendBatch(outgoing);
    } catch (error) {
      const event: EmailDeliveryEvent = { type: "failed", at: new Date().toISOString(), detail: errorText(error) };
      result.failed += ids.length;
      log(`a batch of ${ids.length} was not sent: ${event.detail}`);
      try {
        await db
          .update(emailMessages)
          .set({
            status: "failed",
            sentAt: null,
            events: sql`${emailMessages.events} || ${JSON.stringify([event])}::jsonb`,
            lastEventAt: new Date(event.at),
          })
          .where(inArray(emailMessages.id, ids));
      } catch (writeError) {
        statusNotSaved(ids, writeError);
      }
      continue;
    }

    // The provider accepted the chunk: from here on these messages are sent.
    result.sent += ids.length;
    const sentAt = new Date();
    const providerIds = ids.map((_, i) => results[i]?.id ?? null);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= PROVIDER_ID_WRITE_ATTEMPTS; attempt++) {
      try {
        await saveProviderIds(db, ids, providerIds, sentAt);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < PROVIDER_ID_WRITE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, PROVIDER_ID_RETRY_DELAY_MS * attempt));
        }
      }
    }
    if (!lastError) continue;
    // The webhook still finds these messages by their aw_message tag (D63).
    result.sentWithoutIds += ids.length;
    result.providerIdError = errorText(lastError);
    log(`a batch of ${ids.length} was sent but its provider ids were not saved: ${result.providerIdError}`);
    try {
      await db
        .update(emailMessages)
        .set({
          status: sql`case when ${emailMessages.status} = 'queued' then 'sent'::email_message_status else ${emailMessages.status} end`,
          sentAt,
        })
        .where(inArray(emailMessages.id, ids));
    } catch (writeError) {
      statusNotSaved(ids, writeError);
    }
  }
  return result;
}

/** What the audit row says about writes that failed during delivery, if any. */
function deliveryProblems(d: Delivered) {
  return {
    ...(d.sentWithoutIds > 0 ? { sentWithoutIds: d.sentWithoutIds, providerIdError: d.providerIdError } : {}),
    ...(d.statusNotSaved > 0 ? { statusNotSaved: d.statusNotSaved, statusError: d.statusError } : {}),
  };
}

/**
 * Locks the event row (`FOR UPDATE`) and returns its status, or null when the
 * event is gone. Every transaction here that writes a campaign row calls this
 * (or `claimEvent`) first, so they all lock the event before the
 * campaign and two of them can't deadlock. Unlock, archive, and retention
 * take the event row first too.
 */
async function lockEventRow(tx: Db, eventId: string): Promise<Event["status"] | null> {
  const [event] = await tx.select({ status: events.status }).from(events).where(eq(events.id, eventId)).for("update");
  return event?.status ?? null;
}

/**
 * Claims the campaign for a send: inside one transaction, locks the event row
 * and rechecks that it is locked or sent, then moves the campaign from `from`
 * to `sending` with a compare-and-set (D95). Unlock and archive refuse while a
 * campaign is `sending`, so the event can't leave locked or sent mid-send.
 */
async function claimCampaign(
  db: Db,
  campaign: EmailCampaign,
  from: EmailCampaign["status"],
): Promise<ActionResult<EmailCampaign>> {
  return db.transaction(async (tx) => {
    const status = await lockEventRow(tx, campaign.eventId);
    if (!status) return fail("not_found", "That event no longer exists.");
    if (!eventAllows("locked", status)) return fail("locked", NOT_LOCKED_MESSAGE);
    const [claimed] = await tx
      .update(emailCampaigns)
      .set({ status: "sending" })
      .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, from)))
      .returning();
    if (!claimed) return fail("conflict", "This campaign is already being sent.");
    return ok(claimed);
  });
}

/**
 * The fallback when a send's closing write fails: moves the campaign from
 * `sending` to `failed` in a transaction of its own, with the reason in a
 * `email.send` audit row (the campaign row has no column for it). A campaign
 * left `sending` would block unlock, archive, and retention. When some
 * messages went out the event still moves from locked to sent. A failure here
 * is only logged; retention fails a stale `sending` campaign later.
 */
async function markSendFailed(
  db: Db,
  input: {
    campaign: EmailCampaign;
    adminId: string;
    recipientCount: number;
    advanceEvent: boolean;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { campaign } = input;
  try {
    await db.transaction(async (tx) => {
      await lockEventRow(tx, campaign.eventId);
      if (input.advanceEvent) await advanceStatus(tx, campaign.eventId, "locked", "sent");
      const [row] = await tx
        .update(emailCampaigns)
        .set({ status: "failed", sentAt: new Date(), sentBy: input.adminId, recipientCount: input.recipientCount })
        .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, "sending")))
        .returning({ id: emailCampaigns.id });
      if (!row) return;
      await recordAudit(tx, {
        eventId: campaign.eventId,
        adminId: input.adminId,
        action: "email.send",
        entityType: "email_campaign",
        entityId: campaign.id,
        before: input.before,
        after: { ...input.after, status: "failed" },
      });
    });
  } catch (error) {
    console.error(`[email] campaign ${campaign.id}: could not mark the send failed, it stays sending: ${errorText(error)}`);
  }
}

async function loadSendable(
  db: Db,
  campaignId: string,
): Promise<ActionResult<{ campaign: EmailCampaign; event: Event }>> {
  const campaign = await loadCampaign(db, campaignId);
  if (!campaign) return fail("not_found", "That campaign no longer exists.");
  const event = await getEvent(campaign.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (!eventAllows("locked", event.status)) return fail("locked", NOT_LOCKED_MESSAGE);
  return ok({ campaign, event });
}

/**
 * Sends a draft to its audience. Refuses unless the event is locked or sent.
 * The first send that reaches anyone moves the event from locked to sent.
 */
export async function sendCampaign(
  db: Db,
  input: { campaignId: string; adminId: string },
  options: { isProduction?: boolean } = {},
): Promise<ActionResult<SendResult>> {
  if (emailNotConfigured(options.isProduction ?? env.isProduction)) {
    return fail("internal", EMAIL_NOT_CONFIGURED_MESSAGE);
  }
  const loaded = await loadSendable(db, input.campaignId);
  if (!loaded.ok) return loaded;
  const { campaign, event } = loaded.data;
  if (campaign.status !== "draft") return fail("conflict", "This campaign was already sent.");
  const fields = campaignFieldsSchema.safeParse(campaign);
  if (!fields.success) return fromZod(fields.error);
  const unknown = findUnknownFields(`${campaign.subject} ${campaign.htmlBody}`);
  if (unknown.length > 0) {
    return fail("validation", `Fix the unknown merge fields before sending: ${unknown.join(", ")}.`);
  }

  // Claim the campaign so a double click or a second admin can't send it twice.
  const claim = await claimCampaign(db, campaign, "draft");
  if (!claim.ok) return claim;
  const claimed = claim.data;

  let recipients: Recipient[];
  let skippedRevoked: number;
  try {
    const resolved = await resolveAudience(db, event.id, claimed.audience, claimed.selectedRecipients, { links: "issue" });
    if (!resolved.ok) throw new Error(resolved.error.message);
    // A revoked link stays revoked: those people are left out, never given a new link here.
    recipients = resolved.data.filter((r) => !r.linkRevoked);
    skippedRevoked = resolved.data.length - recipients.length;
  } catch (error) {
    await db.update(emailCampaigns).set({ status: "draft" }).where(eq(emailCampaigns.id, campaign.id));
    return fail("internal", `Nothing was sent: ${errorText(error)}`);
  }
  if (recipients.length === 0) {
    await db.update(emailCampaigns).set({ status: "draft" }).where(eq(emailCampaigns.id, campaign.id));
    return fail(
      "validation",
      skippedRevoked > 0
        ? `Nothing was sent: everyone in this audience has a revoked link. ${REGENERATE_HINT}`
        : claimed.audience === "changed_since_last_send"
          ? "Nobody's schedule changed since their last email, so there is no one to send to."
          : "Nobody in this audience has an email address. Pick another audience.",
    );
  }

  const before = { status: "draft", eventStatus: event.status };
  const summary = {
    kind: claimed.kind,
    audience: claimed.audience,
    recipients: recipients.length,
    ...(skippedRevoked > 0 ? { skippedRevoked } : {}),
  };
  let delivered: Delivered;
  try {
    delivered = await deliver(db, claimed, recipients);
  } catch (error) {
    // Never leave the campaign in "sending": mark it failed so "Resend to
    // bounced" can pick up everyone who didn't get it.
    const failureReason = errorText(error);
    console.error(`[email] campaign ${campaign.id}: delivery stopped: ${failureReason}`);
    await markSendFailed(db, {
      campaign,
      adminId: input.adminId,
      recipientCount: recipients.length,
      advanceEvent: false,
      before,
      after: { ...summary, failureReason },
    });
    return fail("internal", `Sending stopped before it finished: ${failureReason} Use Resend to bounced to retry.`);
  }
  const { sent, failed } = delivered;
  const status = sent > 0 ? "sent" : "failed";
  let eventAdvanced: boolean;
  try {
    eventAdvanced = await db.transaction(async (tx) => {
      // The event row first, then the campaign row (`lockEventRow`).
      await lockEventRow(tx, event.id);
      const advanced = sent > 0 ? await advanceStatus(tx, event.id, "locked", "sent") : false;
      await tx
        .update(emailCampaigns)
        .set({ status, sentAt: new Date(), sentBy: input.adminId, recipientCount: recipients.length })
        .where(eq(emailCampaigns.id, campaign.id));
      await recordAudit(tx, {
        eventId: event.id,
        adminId: input.adminId,
        action: "email.send",
        entityType: "email_campaign",
        entityId: campaign.id,
        before,
        after: { status, ...summary, sent, failed, eventAdvanced: advanced, ...deliveryProblems(delivered) },
      });
      return advanced;
    });
  } catch (error) {
    // The messages went out (or failed) as recorded per message; only the
    // campaign's own result was lost. Failed, not sending: unlock, archive,
    // and retention wait on sending, and resend skips everyone handed over.
    const failureReason = `The send finished but its result was not saved: ${errorText(error)}`;
    console.error(`[email] campaign ${campaign.id}: ${failureReason}`);
    await markSendFailed(db, {
      campaign,
      adminId: input.adminId,
      recipientCount: recipients.length,
      advanceEvent: sent > 0,
      before,
      after: { ...summary, sent, failed, ...deliveryProblems(delivered), failureReason },
    });
    return fail(
      "internal",
      `${sent} of ${recipients.length} emails went out, but the result was not saved, so the campaign is marked failed. Check the delivery table, then use Resend to bounced for anyone who didn't get it.`,
    );
  }
  return ok({
    campaignId: campaign.id,
    eventId: event.id,
    recipients: recipients.length,
    sent,
    failed,
    skippedRevoked,
    eventAdvanced,
    delivered: isEmailConfigured(),
  });
}

/** Statuses "Resend to bounced" retries: the message never reached the person. */
export const RESENDABLE_STATUSES: readonly EmailMessageStatus[] = ["bounced", "failed"];

/**
 * True when "Resend to bounced" may send this message's recipient the
 * campaign again: it bounced or failed, or it is still queued and was never
 * handed to the provider (no `sentAt`, see `deliver`). A queued message with
 * a hand-off time may have been accepted, so it is never sent again.
 */
export function isResendable(message: { status: EmailMessageStatus; sentAt: Date | null }): boolean {
  return RESENDABLE_STATUSES.includes(message.status) || (message.status === "queued" && message.sentAt === null);
}

/**
 * Sends the campaign again to recipients whose latest message in it is
 * resendable (`isResendable`), at their current address (an admin may have
 * fixed it). For a failed campaign it also covers audience members the send
 * never reached. People whose link was revoked are left out.
 */
export async function resendToBounced(
  db: Db,
  input: { campaignId: string; adminId: string },
  options: { isProduction?: boolean } = {},
): Promise<ActionResult<SendResult>> {
  if (emailNotConfigured(options.isProduction ?? env.isProduction)) {
    return fail("internal", EMAIL_NOT_CONFIGURED_MESSAGE);
  }
  const loaded = await loadSendable(db, input.campaignId);
  if (!loaded.ok) return loaded;
  const { campaign, event } = loaded.data;
  if (campaign.status === "sending") return fail("conflict", "This campaign is already being sent.");
  if (campaign.status !== "sent" && campaign.status !== "failed") {
    return fail("conflict", "Send the campaign before resending to bounced addresses.");
  }
  // Claim it like a first send, so two clicks can't both pick the same
  // bounced recipients. The status goes back when this finishes.
  const claim = await claimCampaign(db, campaign, campaign.status);
  if (!claim.ok) return claim;
  let restoreTo: EmailCampaign["status"] = campaign.status;
  try {
    const latest = await db
      .selectDistinctOn([emailMessages.contactType, emailMessages.entityId], {
        contactType: emailMessages.contactType,
        entityId: emailMessages.entityId,
        status: emailMessages.status,
        sentAt: emailMessages.sentAt,
      })
      .from(emailMessages)
      .where(eq(emailMessages.campaignId, campaign.id))
      .orderBy(emailMessages.contactType, emailMessages.entityId, desc(emailMessages.createdAt));
    const keys = latest.filter(isResendable).map((m) => recipientKey(m.contactType, m.entityId));
    // A failed campaign may have stopped before its messages were written:
    // audience members without a message were never reached.
    if (campaign.status === "failed") {
      const audience = await resolveAudience(db, event.id, campaign.audience, campaign.selectedRecipients, {
        links: "existing",
      });
      if (!audience.ok) return audience;
      const messaged = new Set(latest.map((m) => recipientKey(m.contactType, m.entityId)));
      keys.push(...audience.data.filter((r) => !messaged.has(r.key)).map((r) => r.key));
    }
    if (keys.length === 0) return fail("validation", "No message in this campaign bounced or failed.");

    const resolved = await resolveAudience(db, event.id, "selected", keys, { links: "issue" });
    if (!resolved.ok) return resolved;
    const recipients = resolved.data.filter((r) => !r.linkRevoked);
    const skippedRevoked = resolved.data.length - recipients.length;
    if (recipients.length === 0) {
      return fail(
        "validation",
        skippedRevoked > 0
          ? `Nothing was sent: everyone left to retry has a revoked link. ${REGENERATE_HINT}`
          : "Everyone whose email bounced has since been withdrawn or has no email address.",
      );
    }
    const delivered = await deliver(db, campaign, recipients);
    const { sent, failed } = delivered;
    if (sent > 0) restoreTo = "sent";
    const eventAdvanced = await db.transaction(async (tx) => {
      // The event row first (`lockEventRow`); the `finally` below writes the campaign row on its own.
      await lockEventRow(tx, event.id);
      const advanced = sent > 0 ? await advanceStatus(tx, event.id, "locked", "sent") : false;
      await recordAudit(tx, {
        eventId: event.id,
        adminId: input.adminId,
        action: "email.resend",
        entityType: "email_campaign",
        entityId: campaign.id,
        after: {
          recipients: recipients.length,
          sent,
          failed,
          ...(skippedRevoked > 0 ? { skippedRevoked } : {}),
          eventAdvanced: advanced,
          ...deliveryProblems(delivered),
        },
      });
      return advanced;
    });
    return ok({
      campaignId: campaign.id,
      eventId: event.id,
      recipients: recipients.length,
      sent,
      failed,
      skippedRevoked,
      eventAdvanced,
      delivered: isEmailConfigured(),
    });
  } finally {
    await db
      .update(emailCampaigns)
      .set({ status: restoreTo })
      .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, "sending")));
  }
}
