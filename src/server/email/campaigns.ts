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
import { env } from "@/lib/env";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { campaignFieldsSchema, recipientKey, type CampaignFieldsInput } from "@/lib/schemas/email";
import { recordAudit } from "@/server/audit/audit";
import { getEvent } from "@/server/events/queries";
import { advanceStatus } from "@/server/events/status";
import { findUnknownFields, renderTemplate, renderText, SAMPLE_MERGE_VALUES, type MergeValues } from "./merge";
import { listAudienceContacts, resolveAudience, withLinks, type Recipient } from "./recipients";
import { hashForContact, scheduleHashesForEvent } from "./schedule-hash";

/**
 * Campaigns: create, edit while draft, duplicate, preview, test, send, and
 * resend to bounced (scope 2.7). Every send goes through the email adapter;
 * nothing here logs a message body.
 */

/** Resend's batch API takes at most 100 messages per call. */
export const SEND_CHUNK_SIZE = 100;

/** Event statuses that allow sending: every link is final (AGENTS.md, scope 2.6). */
const SENDABLE_EVENT_STATUSES: readonly Event["status"][] = ["locked", "sent"];

export const NOT_LOCKED_MESSAGE = "Lock the schedule before sending so every link is final.";

export const EMAIL_NOT_CONFIGURED_MESSAGE = "Email is not configured for this deployment. Add RESEND_API_KEY.";

/**
 * In production the logger adapter would "send" to the server log and mark
 * every message sent, so a campaign refuses instead. Tests pass `isProduction`.
 */
function emailNotConfigured(isProduction: boolean): boolean {
  return isProduction && !isEmailConfigured();
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

/** The refusal for a missing or archived event, else null. Same wording as create and duplicate. */
async function refuseArchived(db: Db, eventId: string): Promise<ActionResult<never> | null> {
  const event = await getEvent(eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status === "archived") return fail("locked", "This event is archived.");
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
  const event = await getEvent(input.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status === "archived") return fail("locked", "This event is archived.");
  const kind = input.kind ?? "initial";
  const sender = await senderDefaults(db, event.id, input.adminId);
  const [row] = await db
    .insert(emailCampaigns)
    .values({
      eventId: event.id,
      name: DEFAULT_NAMES[kind],
      ...sender,
      subject: DEFAULT_SUBJECTS[kind],
      htmlBody: DEFAULT_BODIES[kind],
      audience: kind === "update" ? "changed_since_last_send" : "all",
      kind,
      createdBy: input.adminId,
    })
    .returning();
  await recordAudit(db, {
    eventId: event.id,
    adminId: input.adminId,
    action: "email.create",
    entityType: "email_campaign",
    entityId: row.id,
    after: campaignSnapshot(row),
  });
  return ok(row);
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
  const [row] = await db
    .update(emailCampaigns)
    .set({
      ...fields,
      selectedRecipients: fields.audience === "selected" ? fields.selectedRecipients : [],
    })
    .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, "draft")))
    .returning();
  if (!row) return fail("conflict", "This campaign was sent while you were editing.");
  await recordAudit(db, {
    eventId: campaign.eventId,
    adminId: input.adminId,
    action: "email.update",
    entityType: "email_campaign",
    entityId: campaign.id,
    before: campaignSnapshot(campaign),
    after: campaignSnapshot(row),
  });
  return ok(row);
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
  const event = await getEvent(source.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status === "archived") return fail("locked", "This event is archived.");
  const isUpdate = input.kind === "update";
  const [row] = await db
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
  await recordAudit(db, {
    eventId: source.eventId,
    adminId: input.adminId,
    action: "email.duplicate",
    entityType: "email_campaign",
    entityId: row.id,
    after: { ...campaignSnapshot(row), sourceId: source.id },
  });
  return ok(row);
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

/**
 * One contact's merge values without writing anything: the chosen contact if
 * given, else the first of the audience, else anyone, else sample values.
 */
async function sampleRecipient(
  db: Db,
  campaign: EmailCampaign,
  key: string | undefined,
): Promise<ActionResult<{ recipient: Recipient | null; values: MergeValues }>> {
  const contacts = await listAudienceContacts(db, campaign.eventId);
  if (!contacts) return fail("not_found", "That event no longer exists.");
  let chosen = key ? contacts.find((c) => c.key === key) : undefined;
  if (key && !chosen) return fail("not_found", "That recipient is no longer on the roster.");
  if (!chosen) {
    const audience = await resolveAudience(db, campaign.eventId, campaign.audience, campaign.selectedRecipients, {
      links: "existing",
    });
    if (!audience.ok) return audience;
    chosen = audience.data[0] ?? contacts[0];
  }
  if (!chosen) return ok({ recipient: null, values: SAMPLE_MERGE_VALUES });
  const withLink = await withLinks(db, campaign.eventId, [chosen], "existing");
  if (!withLink.ok) return withLink;
  const recipient = withLink.data[0];
  return ok({ recipient, values: recipient.mergeValues });
}

function render(subject: string, htmlBody: string, values: MergeValues): { subject: string; html: string } {
  return { subject: renderText(subject, values), html: emailDocument(renderTemplate(htmlBody, values)) };
}

/** Subject and body as one recipient will see them. Pass `subject`/`htmlBody` to preview unsaved edits. */
export async function previewCampaign(
  db: Db,
  input: { campaignId: string; recipient?: string; subject?: string; htmlBody?: string },
): Promise<ActionResult<RenderedEmail>> {
  const campaign = await loadCampaign(db, input.campaignId);
  if (!campaign) return fail("not_found", "That campaign no longer exists.");
  const sample = await sampleRecipient(db, campaign, input.recipient);
  if (!sample.ok) return sample;
  const subject = input.subject ?? campaign.subject;
  const htmlBody = input.htmlBody ?? campaign.htmlBody;
  const r = sample.data.recipient;
  return ok({
    recipient: r ? { key: r.key, name: r.name, email: r.email } : null,
    ...render(subject, htmlBody, sample.data.values),
    unknownFields: findUnknownFields(`${subject} ${htmlBody}`),
  });
}

export const TEST_SEND_ADMINS_ONLY = "Test emails go only to active admins. Use your own address or a colleague's from the Team page.";

/** Sends the saved campaign to one active admin's address with a sample recipient's values. */
export async function sendTest(
  db: Db,
  input: { campaignId: string; toEmail: string; adminId: string; recipient?: string },
): Promise<ActionResult<{ toEmail: string; recipientName: string | null }>> {
  const campaign = await loadCampaign(db, input.campaignId);
  if (!campaign) return fail("not_found", "That campaign no longer exists.");
  const archived = await refuseArchived(db, campaign.eventId);
  if (archived) return archived;
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
  const rendered = render(campaign.subject, campaign.htmlBody, sample.data.values);
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
    return fail("internal", `The test email was not sent: ${errorText(error)}`);
  }
  await db.update(emailCampaigns).set({ testSentAt: new Date() }).where(eq(emailCampaigns.id, campaign.id));
  await recordAudit(db, {
    eventId: campaign.eventId,
    adminId: input.adminId,
    action: "email.test",
    entityType: "email_campaign",
    entityId: campaign.id,
    after: { toEmail: input.toEmail, recipient: sample.data.recipient?.key ?? null },
  });
  return ok({ toEmail: input.toEmail, recipientName: sample.data.recipient?.name ?? null });
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
  eventAdvanced: boolean;
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
 * describes, then sends in chunks of 100. A chunk the provider refuses marks
 * its messages failed; the rest still go. A chunk the provider accepted is
 * never marked failed: if its provider ids can't be saved after retries, its
 * messages become `sent` without ids (D95), since "Resend to bounced" would
 * otherwise mail them twice.
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
  let sent = 0;
  let failed = 0;
  let sentWithoutIds = 0;
  let providerIdError: string | undefined;
  for (let start = 0; start < recipients.length; start += SEND_CHUNK_SIZE) {
    const chunk = recipients.slice(start, start + SEND_CHUNK_SIZE);
    const ids = rows.slice(start, start + SEND_CHUNK_SIZE).map((r) => r.id);
    const outgoing: OutgoingEmail[] = chunk.map((r, i) => ({
      to: r.email,
      from,
      replyTo: campaign.replyTo,
      ...render(campaign.subject, campaign.htmlBody, r.mergeValues),
      // Lets the webhook find the message even before its provider id is saved.
      tags: { aw_message: ids[i] },
    }));
    let results: Awaited<ReturnType<typeof sendBatch>>;
    try {
      results = await sendBatch(outgoing);
    } catch (error) {
      const event: EmailDeliveryEvent = { type: "failed", at: new Date().toISOString(), detail: errorText(error) };
      await db
        .update(emailMessages)
        .set({
          status: "failed",
          events: sql`${emailMessages.events} || ${JSON.stringify([event])}::jsonb`,
          lastEventAt: new Date(event.at),
        })
        .where(inArray(emailMessages.id, ids));
      failed += ids.length;
      console.error(`[email] campaign ${campaign.id}: a batch of ${ids.length} was not sent: ${event.detail}`);
      continue;
    }

    // The provider accepted the chunk: from here on these messages are sent.
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
    if (lastError) {
      // The webhook still finds these messages by their aw_message tag (D63).
      providerIdError = errorText(lastError);
      console.error(
        `[email] campaign ${campaign.id}: a batch of ${ids.length} was sent but its provider ids were not saved: ${providerIdError}`,
      );
      await db
        .update(emailMessages)
        .set({
          status: sql`case when ${emailMessages.status} = 'queued' then 'sent'::email_message_status else ${emailMessages.status} end`,
          sentAt,
        })
        .where(inArray(emailMessages.id, ids));
      sentWithoutIds += ids.length;
    }
    sent += ids.length;
  }
  return { sent, failed, sentWithoutIds, ...(providerIdError ? { providerIdError } : {}) };
}

/** What the audit row says about provider ids that could not be saved, if any. */
function providerIdProblem(d: Delivered) {
  return d.sentWithoutIds > 0 ? { sentWithoutIds: d.sentWithoutIds, providerIdError: d.providerIdError } : {};
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
    const [event] = await tx
      .select({ status: events.status })
      .from(events)
      .where(eq(events.id, campaign.eventId))
      .for("update");
    if (!event) return fail("not_found", "That event no longer exists.");
    if (!SENDABLE_EVENT_STATUSES.includes(event.status)) return fail("locked", NOT_LOCKED_MESSAGE);
    const [claimed] = await tx
      .update(emailCampaigns)
      .set({ status: "sending" })
      .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, from)))
      .returning();
    if (!claimed) return fail("conflict", "This campaign is already being sent.");
    return ok(claimed);
  });
}

async function loadSendable(
  db: Db,
  campaignId: string,
): Promise<ActionResult<{ campaign: EmailCampaign; event: Event }>> {
  const campaign = await loadCampaign(db, campaignId);
  if (!campaign) return fail("not_found", "That campaign no longer exists.");
  const event = await getEvent(campaign.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (!SENDABLE_EVENT_STATUSES.includes(event.status)) return fail("locked", NOT_LOCKED_MESSAGE);
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
  try {
    const resolved = await resolveAudience(db, event.id, claimed.audience, claimed.selectedRecipients, { links: "issue" });
    if (!resolved.ok) throw new Error(resolved.error.message);
    recipients = resolved.data;
  } catch (error) {
    await db.update(emailCampaigns).set({ status: "draft" }).where(eq(emailCampaigns.id, campaign.id));
    return fail("internal", `Nothing was sent: ${errorText(error)}`);
  }
  if (recipients.length === 0) {
    await db.update(emailCampaigns).set({ status: "draft" }).where(eq(emailCampaigns.id, campaign.id));
    return fail(
      "validation",
      claimed.audience === "changed_since_last_send"
        ? "Nobody's schedule changed since their last email, so there is no one to send to."
        : "Nobody in this audience has an email address. Pick another audience.",
    );
  }

  let delivered: Delivered;
  try {
    delivered = await deliver(db, claimed, recipients);
  } catch (error) {
    // Never leave the campaign in "sending": mark it failed so "Resend to
    // bounced" can pick up everyone who didn't get it. The campaign row has no
    // column for the reason, so the audit row keeps it.
    const failureReason = errorText(error);
    console.error(`[email] campaign ${campaign.id}: delivery stopped: ${failureReason}`);
    await db
      .update(emailCampaigns)
      .set({ status: "failed", sentAt: new Date(), sentBy: input.adminId, recipientCount: recipients.length })
      .where(eq(emailCampaigns.id, campaign.id));
    await recordAudit(db, {
      eventId: event.id,
      adminId: input.adminId,
      action: "email.send",
      entityType: "email_campaign",
      entityId: campaign.id,
      before: { status: "draft", eventStatus: event.status },
      after: {
        status: "failed",
        kind: claimed.kind,
        audience: claimed.audience,
        recipients: recipients.length,
        failureReason,
      },
    });
    return fail("internal", `Sending stopped before it finished: ${failureReason} Use Resend to bounced to retry.`);
  }
  const { sent, failed } = delivered;
  const sentAt = new Date();
  await db
    .update(emailCampaigns)
    .set({ status: sent > 0 ? "sent" : "failed", sentAt, sentBy: input.adminId, recipientCount: recipients.length })
    .where(eq(emailCampaigns.id, campaign.id));
  const eventAdvanced = sent > 0 ? await advanceStatus(db, event.id, "locked", "sent") : false;
  await recordAudit(db, {
    eventId: event.id,
    adminId: input.adminId,
    action: "email.send",
    entityType: "email_campaign",
    entityId: campaign.id,
    before: { status: "draft", eventStatus: event.status },
    after: {
      status: sent > 0 ? "sent" : "failed",
      kind: claimed.kind,
      audience: claimed.audience,
      recipients: recipients.length,
      sent,
      failed,
      eventAdvanced,
      ...providerIdProblem(delivered),
    },
  });
  return ok({ campaignId: campaign.id, eventId: event.id, recipients: recipients.length, sent, failed, eventAdvanced });
}

/** Statuses "Resend to bounced" retries: the message never reached the person. */
export const RESENDABLE_STATUSES: readonly EmailMessageStatus[] = ["bounced", "failed"];

/**
 * Sends the campaign again to recipients whose latest message in it bounced
 * or failed, at their current address (an admin may have fixed it). For a
 * failed campaign it also covers recipients the send never reached.
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
      })
      .from(emailMessages)
      .where(eq(emailMessages.campaignId, campaign.id))
      .orderBy(emailMessages.contactType, emailMessages.entityId, desc(emailMessages.createdAt));
    // A failed campaign may have stopped mid-way: messages still queued never
    // went out, and audience members without a message were never reached.
    const retryStatuses: readonly EmailMessageStatus[] =
      campaign.status === "failed" ? [...RESENDABLE_STATUSES, "queued"] : RESENDABLE_STATUSES;
    const keys = latest
      .filter((m) => retryStatuses.includes(m.status))
      .map((m) => recipientKey(m.contactType, m.entityId));
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
    if (resolved.data.length === 0) {
      return fail("validation", "Everyone whose email bounced has since been withdrawn or has no email address.");
    }
    const delivered = await deliver(db, campaign, resolved.data);
    const { sent, failed } = delivered;
    if (sent > 0) restoreTo = "sent";
    const eventAdvanced = sent > 0 ? await advanceStatus(db, event.id, "locked", "sent") : false;
    await recordAudit(db, {
      eventId: event.id,
      adminId: input.adminId,
      action: "email.resend",
      entityType: "email_campaign",
      entityId: campaign.id,
      after: { recipients: resolved.data.length, sent, failed, eventAdvanced, ...providerIdProblem(delivered) },
    });
    return ok({ campaignId: campaign.id, eventId: event.id, recipients: resolved.data.length, sent, failed, eventAdvanced });
  } finally {
    await db
      .update(emailCampaigns)
      .set({ status: restoreTo })
      .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, "sending")));
  }
}
