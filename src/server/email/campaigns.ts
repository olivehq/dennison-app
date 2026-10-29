import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { admins, emailCampaigns, emailMessages, events, type EmailCampaign, type EmailCampaignKind, type Event } from "@/db/schema";
import { isEmailConfigured, sendEmail } from "@/lib/email/adapter";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";
import { env } from "@/lib/env";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { eventAllows } from "@/lib/event-gates";
import { campaignFieldsSchema, recipientKey, type CampaignFieldsInput, type EmailAudience } from "@/lib/schemas/email";
import { recordAudit } from "@/server/audit/audit";
import { claimEvent, inEventTransaction, Refused } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { advanceStatus } from "@/server/events/status";
import { transitionCampaign } from "./campaign-status";
import { deliverCampaign, deliveryProblems, errorText, isResendable, retryRecipients, type Delivered } from "./delivery";
import { findUnknownFields, renderEmail, SAMPLE_MERGE_VALUES, type MergeValues } from "./merge";
import { audienceContactsFor, listAudienceContacts, resolveAudience, withLinks, type Recipient } from "./recipients";

export { emailDocument } from "./merge";

/**
 * Campaigns: create, edit while draft, duplicate, preview, test, send, and
 * resend to bounced (scope 2.7). Every send goes through the email adapter;
 * nothing here logs a message body.
 */

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
    ...renderEmail(subject, safeBody, sample.data.values),
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
  const rendered = renderEmail(campaign.subject, sanitizeEmailHtml(campaign.htmlBody), sample.data.values);
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

/** Not confirmed sent: refused, never handed over, or handed over with no answer (`Delivered.uncertain`). */
function notConfirmed(d: Delivered): number {
  return d.failed + d.uncertain;
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
    const claimed = await transitionCampaign(tx, campaign.id, from, "sending");
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
 * is only logged; unlock, archive, and retention fail a stale `sending`
 * campaign later (`repairStaleSends`).
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
      const row = await transitionCampaign(tx, campaign.id, "sending", "failed", {
        sentAt: new Date(),
        sentBy: input.adminId,
        recipientCount: input.recipientCount,
      });
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
    await transitionCampaign(db, campaign.id, "sending", "draft");
    return fail("internal", `Nothing was sent: ${errorText(error)}`);
  }
  if (recipients.length === 0) {
    await transitionCampaign(db, campaign.id, "sending", "draft");
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
    delivered = await deliverCampaign(db, claimed, recipients);
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
  const { sent } = delivered;
  const failed = notConfirmed(delivered);
  const status = sent > 0 ? "sent" : "failed";
  let eventAdvanced: boolean;
  try {
    eventAdvanced = await db.transaction(async (tx) => {
      // The event row first, then the campaign row (`lockEventRow`).
      await lockEventRow(tx, event.id);
      const advanced = sent > 0 ? await advanceStatus(tx, event.id, "locked", "sent") : false;
      const closed = await transitionCampaign(tx, campaign.id, "sending", status, {
        sentAt: new Date(),
        sentBy: input.adminId,
        recipientCount: recipients.length,
      });
      if (!closed) throw new Error("The campaign was no longer marked sending.");
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
    // and retention wait on sending, and resend retries uncertain batches only
    // under their key (D185).
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

/**
 * Sends the campaign again to recipients whose latest message in it is
 * resendable (`isResendable`), at their current address (an admin may have
 * fixed it); a message whose batch got no answer goes again under the same
 * key (`retryRecipients`). For a failed campaign it also covers audience
 * members the send never reached. People whose link was revoked are left out.
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
        batchKey: emailMessages.batchKey,
      })
      .from(emailMessages)
      .where(eq(emailMessages.campaignId, campaign.id))
      .orderBy(emailMessages.contactType, emailMessages.entityId, desc(emailMessages.createdAt));
    const now = new Date();
    const keys = latest.filter((m) => isResendable(m, now)).map((m) => recipientKey(m.contactType, m.entityId));
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
    const delivered = await retryRecipients(db, campaign, recipients, now);
    const { sent } = delivered;
    const failed = notConfirmed(delivered);
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
    await transitionCampaign(db, campaign.id, "sending", restoreTo);
  }
}
