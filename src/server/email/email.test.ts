import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { auditEvents, emailCampaigns, emailMessages, events, participants, type EmailCampaign } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { clearLoggedEmails, getLoggedEmails, sendBatch } from "@/lib/email/adapter";
import { campaignFieldsSchema, recipientKey, type CampaignFieldsInput } from "@/lib/schemas/email";
import { getActiveRun } from "@/server/matching/queries";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { replaceAppointment, swapCandidates } from "@/server/schedule/edits";
import { lockSchedule, unlockSchedule } from "@/server/schedule/lock";
import { verifyToken } from "@/server/tokens/tokens";
import {
  createCampaign,
  duplicateCampaign,
  previewCampaign,
  resendToBounced,
  sendCampaign,
  sendTest,
  TEST_SEND_ADMINS_ONLY,
  updateCampaign,
} from "./campaigns";
import { campaignStats, getAudienceOptions, getCampaign, getEmailSummary, listCampaigns } from "./queries";
import { resolveAudience } from "./recipients";
import {
  changedSinceLastSend,
  countChangedSinceLastSend,
  scheduleChangeState,
  scheduleHashesForEvent,
  scheduleHashFor,
} from "./schedule-hash";
import { handleResendWebhook, recordDeliveryEvent } from "./webhook";

vi.mock("@/lib/email/adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/adapter")>();
  return { ...actual, sendBatch: vi.fn(actual.sendBatch) };
});

vi.mock("./schedule-hash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schedule-hash")>();
  return { ...actual, scheduleHashesForEvent: vi.fn(actual.scheduleHashesForEvent) };
});

let db: Db;
let seeded: Seeded;
let withdrawnId: string;

function fieldsOf(c: EmailCampaign, overrides: Partial<CampaignFieldsInput> = {}): CampaignFieldsInput {
  return {
    name: c.name,
    fromName: c.fromName,
    fromEmail: c.fromEmail,
    replyTo: c.replyTo,
    subject: c.subject,
    htmlBody: c.htmlBody,
    audience: c.audience,
    selectedRecipients: c.selectedRecipients,
    ...overrides,
  };
}

async function messagesOf(campaignId: string) {
  return db.select().from(emailMessages).where(eq(emailMessages.campaignId, campaignId));
}

async function eventStatus() {
  const [row] = await db.select({ status: events.status }).from(events).where(eq(events.id, seeded.eventId));
  return row.status;
}

async function newDraft(kind: "initial" | "update" = "initial") {
  const created = await createCampaign(db, { eventId: seeded.eventId, adminId: seeded.adminId, kind });
  if (!created.ok) throw new Error(created.error.message);
  return created.data;
}

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
  // One withdrawn buyer, who must never get mail. Withdrawn before matching:
  // lock refuses a schedule that still holds a withdrawn person's appointments.
  withdrawnId = seeded.buyers[11].id;
  await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, withdrawnId));
  const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
  if (!run.ok) throw new Error(run.error.message);
  clearLoggedEmails();
});

describe("campaign fields", () => {
  it("requires a reply-to address", () => {
    const base = {
      name: "Schedules",
      fromName: "AW",
      fromEmail: "schedule@example.com",
      subject: "Hi",
      htmlBody: "<p>Hi</p>",
      audience: "all",
    };
    const missing = campaignFieldsSchema.safeParse(base);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((i) => i.path.join("."))).toContain("replyTo");
    const blank = campaignFieldsSchema.safeParse({ ...base, replyTo: " " });
    expect(blank.success).toBe(false);
    expect(campaignFieldsSchema.safeParse({ ...base, replyTo: "Team@Example.com" }).data?.replyTo).toBe(
      "team@example.com",
    );
  });

  it("needs at least one recipient for a selected audience", () => {
    const result = campaignFieldsSchema.safeParse({
      name: "x",
      fromName: "x",
      fromEmail: "a@example.com",
      replyTo: "b@example.com",
      subject: "x",
      htmlBody: "",
      audience: "selected",
    });
    expect(result.error?.issues[0].path).toEqual(["selectedRecipients"]);
  });
});

describe("before lock", () => {
  it("creates a draft with defaults and refuses to send it", async () => {
    const draft = await newDraft();
    expect(draft).toMatchObject({ status: "draft", kind: "initial", audience: "all", replyTo: "admin@example.com" });
    expect(draft.htmlBody).toContain("{{schedule_link}}");
    const sent = await sendCampaign(db, { campaignId: draft.id, adminId: seeded.adminId });
    expect(sent.ok).toBe(false);
    expect(!sent.ok && sent.error.code).toBe("locked");
    expect(await messagesOf(draft.id)).toHaveLength(0);
  });

  it("previews without issuing links", async () => {
    const draft = await newDraft();
    const preview = await previewCampaign(db, { campaignId: draft.id, htmlBody: "<p>{{schedule_link}} {{oops}}</p>" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.html).toContain("/s/link-issued-at-lock");
    expect(preview.data.unknownFields).toEqual(["{{oops}}"]);
    const options = await getAudienceOptions(seeded.eventId, db);
    expect(options?.counts).toEqual({ all: 20, buyers: 11, suppliers: 9, changed_since_last_send: 0 });
  });
});

describe("audiences and links", () => {
  beforeAll(async () => {
    const locked = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    if (!locked.ok) throw new Error(locked.error.message);
  });

  it("resolves all, buyers, suppliers, and selected, without withdrawn people", async () => {
    const all = await resolveAudience(db, seeded.eventId, "all");
    expect(all.ok && all.data.length).toBe(20); // 11 active buyers + 6 supplier admins + 3 attendees
    const buyers = await resolveAudience(db, seeded.eventId, "buyers");
    expect(buyers.ok && buyers.data.length).toBe(11);
    expect(buyers.ok && buyers.data.some((r) => r.entityId === withdrawnId)).toBe(false);
    const supplierRecipients = await resolveAudience(db, seeded.eventId, "suppliers");
    expect(supplierRecipients.ok && supplierRecipients.data.map((r) => r.contactType).sort()).toEqual(
      [...Array(3).fill("supplier_attendee"), ...Array(6).fill("supplier_admin")].sort(),
    );
    const keys = [recipientKey("buyer", seeded.buyers[0].id), recipientKey("buyer", withdrawnId)];
    const selected = await resolveAudience(db, seeded.eventId, "selected", keys);
    expect(selected.ok && selected.data.map((r) => r.entityId)).toEqual([seeded.buyers[0].id]);
  });

  it("uses each contact's existing link, so a second resolve hands out the same one", async () => {
    const first = await resolveAudience(db, seeded.eventId, "all");
    const second = await resolveAudience(db, seeded.eventId, "all");
    if (!first.ok || !second.ok) throw new Error("resolve failed");
    expect(second.data.map((r) => r.mergeValues.schedule_link)).toEqual(first.data.map((r) => r.mergeValues.schedule_link));
    const buyer = first.data.find((r) => r.contactType === "buyer")!;
    const verified = await verifyToken(db, buyer.mergeValues.schedule_link.split("/s/")[1]);
    expect(verified).toMatchObject({ contactType: "buyer", entityId: buyer.entityId, tokenId: buyer.tokenId });
    const supplier = first.data.find((r) => r.contactType === "supplier_admin")!;
    expect(supplier.mergeValues.supplier_name).not.toBe("");
    expect(supplier.mergeValues.desk).toMatch(/^\d+$/);
  });

  it("hashes every schedule the same way one at a time and in bulk", async () => {
    const bulk = await scheduleHashesForEvent(db, seeded.eventId);
    for (const b of seeded.buyers) {
      expect(await scheduleHashFor(db, seeded.eventId, "buyer", b.id)).toBe(bulk.get(`buyer:${b.id}`));
    }
    for (const s of seeded.suppliers) {
      expect(await scheduleHashFor(db, seeded.eventId, "supplier_attendee", s.id)).toBe(bulk.get(`supplier:${s.id}`));
    }
    expect(new Set(bulk.values()).size).toBeGreaterThan(1);
  });
});

describe("sending", () => {
  let campaign: EmailCampaign;

  it("previews and test-sends with a recipient's values", async () => {
    campaign = await newDraft();
    const key = recipientKey("buyer", seeded.buyers[0].id);
    const preview = await previewCampaign(db, { campaignId: campaign.id, recipient: key });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.recipient?.key).toBe(key);
    expect(preview.data.html).toContain(`Hi ${seeded.buyers[0].firstName}`);
    expect(preview.data.html).toMatch(/<a href="http[^"]+\/s\/[A-Za-z0-9_-]{43}">/);

    clearLoggedEmails();
    const stranger = await sendTest(db, { campaignId: campaign.id, toEmail: "me@example.com", adminId: seeded.adminId, recipient: key });
    expect(!stranger.ok && stranger.error).toMatchObject({ code: "validation", message: TEST_SEND_ADMINS_ONLY });
    expect(getLoggedEmails()).toHaveLength(0);

    const test = await sendTest(db, { campaignId: campaign.id, toEmail: "Admin@Example.com", adminId: seeded.adminId, recipient: key });
    expect(test.ok).toBe(true);
    expect(getLoggedEmails()).toHaveLength(1);
    expect(getLoggedEmails()[0]).toMatchObject({ to: "Admin@Example.com", replyTo: "admin@example.com" });
    expect(getLoggedEmails()[0].subject).toMatch(/^\[Test\] /);
    const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id));
    expect(row.testSentAt).not.toBeNull();
    expect(row.status).toBe("draft");
  });

  it("refuses unknown merge fields and only saves drafts with a reply-to", async () => {
    const blank = await updateCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId, fields: fieldsOf(campaign, { replyTo: "" }) });
    expect(!blank.ok && blank.error.fieldErrors?.replyTo).toBeTruthy();
    const typo = await updateCampaign(db, {
      campaignId: campaign.id,
      adminId: seeded.adminId,
      fields: fieldsOf(campaign, { htmlBody: "<p>{{frist_name}}</p>" }),
    });
    expect(typo.ok).toBe(true);
    const refused = await sendCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId });
    expect(!refused.ok && refused.error.message).toContain("{{frist_name}}");
    const fixed = await updateCampaign(db, {
      campaignId: campaign.id,
      adminId: seeded.adminId,
      fields: fieldsOf(campaign, { replyTo: "Desk@DA.example.com", subject: "Your {{event_name}} schedule" }),
    });
    expect(fixed.ok).toBe(true);
    if (fixed.ok) campaign = fixed.data;
    expect(campaign.replyTo).toBe("desk@da.example.com");
  });

  it("refuses to send in production when email is not configured", async () => {
    const refused = await sendCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId }, { isProduction: true });
    expect(!refused.ok && refused.error.message).toBe(
      "Email is not configured for this deployment. Add RESEND_API_KEY.",
    );
    const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id));
    expect(row.status).toBe("draft");
  });

  it("sends one message per recipient, records ids and hashes, and moves the event to sent", async () => {
    clearLoggedEmails();
    expect(await eventStatus()).toBe("locked");
    const result = await sendCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ recipients: 20, sent: 20, failed: 0, eventAdvanced: true });
    expect(await eventStatus()).toBe("sent");

    const rows = await messagesOf(campaign.id);
    expect(rows).toHaveLength(20);
    expect(rows.every((m) => m.status === "sent" && m.providerMessageId && m.sentAt && m.scheduleHash)).toBe(true);
    expect(rows.some((m) => m.entityId === withdrawnId)).toBe(false);

    const logged = getLoggedEmails();
    expect(logged).toHaveLength(20);
    expect(logged.every((m) => m.replyTo === "desk@da.example.com" && m.from.includes("<"))).toBe(true);
    expect(logged.every((m) => !m.html.includes("{{"))).toBe(true);

    const [stored] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id));
    expect(stored).toMatchObject({ status: "sent", recipientCount: 20, sentBy: seeded.adminId });
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "email.send"), eq(auditEvents.entityId, campaign.id)));
    expect(audit[0].after).toMatchObject({ recipients: 20, sent: 20, failed: 0, eventAdvanced: true });

    const again = await sendCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId });
    expect(!again.ok && again.error.code).toBe("conflict");
    const edit = await updateCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId, fields: fieldsOf(campaign) });
    expect(!edit.ok && edit.error.code).toBe("conflict");
  });

  it("lists campaigns with counts and reports nobody changed", async () => {
    const list = await listCampaigns(seeded.eventId, db);
    const item = list.find((c) => c.id === campaign.id);
    expect(item?.counts).toMatchObject({ total: 20, sent: 20 });
    expect(await countChangedSinceLastSend(db, seeded.eventId)).toBe(0);
    const summary = await getEmailSummary(seeded.eventId, db);
    expect(summary).toEqual({ changed: 0, hasSent: true });
    const state = await scheduleChangeState(db, seeded.eventId);
    expect(state.emailed.size).toBe(20);
  });

  it("records webhook events once, never moves status backwards, and keeps bounce reasons", async () => {
    const [first, second] = await messagesOf(campaign.id);
    const at = "2026-11-02T18:05:00.000Z";
    const delivered = { type: "delivered" as const, providerMessageId: first.providerMessageId!, messageId: null, at, webhookId: "wh_1" };
    expect(await recordDeliveryEvent(db, delivered)).toBe("recorded");
    expect(await recordDeliveryEvent(db, delivered)).toBe("duplicate");
    expect(
      await recordDeliveryEvent(db, { ...delivered, type: "sent", webhookId: "wh_0", at: "2026-11-02T18:04:00.000Z" }),
    ).toBe("recorded");
    let [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, first.id));
    expect(row.status).toBe("delivered");
    expect(row.events.map((e) => e.type)).toEqual(["delivered", "sent"]);
    expect(row.lastEventAt?.toISOString()).toBe(at);

    // Matched by our tag even when the provider id is not the one stored.
    const bounce = {
      type: "bounced" as const,
      providerMessageId: "unknown-provider-id",
      messageId: second.id,
      at,
      detail: "Permanent: mailbox does not exist",
      webhookId: "wh_2",
    };
    expect(await recordDeliveryEvent(db, bounce)).toBe("recorded");
    [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, second.id));
    expect(row.status).toBe("bounced");
    expect(
      await recordDeliveryEvent(db, { ...delivered, providerMessageId: "nobody", webhookId: "wh_3" }),
    ).toBe("unknown");

    const detail = await getCampaign(campaign.id, db);
    const bouncedRow = detail?.messages.find((m) => m.id === second.id);
    expect(bouncedRow).toMatchObject({ status: "bounced", reason: "Permanent: mailbox does not exist" });
    expect((await campaignStats(campaign.id, db)).bounced).toBe(1);
  });

  it("resends only to recipients whose last message bounced", async () => {
    clearLoggedEmails();
    const result = await resendToBounced(db, { campaignId: campaign.id, adminId: seeded.adminId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ recipients: 1, sent: 1 });
    expect(getLoggedEmails()).toHaveLength(1);
    expect(await messagesOf(campaign.id)).toHaveLength(21);
    const detail = await getCampaign(campaign.id, db);
    expect(detail?.messages).toHaveLength(20);
    expect(detail?.stats).toMatchObject({ total: 20, bounced: 0 });
    expect(detail?.messages.filter((m) => m.attempts === 2)).toHaveLength(1);

    const nothing = await resendToBounced(db, { campaignId: campaign.id, adminId: seeded.adminId });
    expect(!nothing.ok && nothing.error.code).toBe("validation");
  });

  it("duplicates as a reminder draft with the same copy", async () => {
    const copy = await duplicateCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId, kind: "reminder" });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.data).toMatchObject({
      kind: "reminder",
      status: "draft",
      htmlBody: campaign.htmlBody,
      replyTo: "desk@da.example.com",
      audience: "all",
      sentAt: null,
    });
  });
});

describe("changed since last send (D13)", () => {
  it("flags only the people an edit touched and sends the update to them alone", async () => {
    const unlocked = await unlockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId, reason: "Late change" });
    expect(unlocked.ok).toBe(true);
    const run = (await getActiveRun(seeded.eventId, db))!;
    const view = await db.query.appointments.findMany({ where: (a, { eq: is }) => is(a.runId, run.id) });
    let edit: { slot: number; supplierId: string; removeBuyerId: string; addBuyerId: string } | null = null;
    for (const a of view) {
      // The withdrawn buyer was never emailed, so an edit touching them would
      // not count as a change (D61). Pick an appointment between active people.
      if (a.buyerId === withdrawnId) continue;
      const candidates = await swapCandidates(db, { runId: run.id, supplierId: a.supplierId, slot: a.slot, excludeBuyerId: a.buyerId });
      if (candidates.ok && candidates.data.length > 0) {
        edit = { slot: a.slot, supplierId: a.supplierId, removeBuyerId: a.buyerId, addBuyerId: candidates.data[0].buyerId };
        break;
      }
    }
    if (!edit) throw new Error("no swappable appointment in the fixture");
    const replaced = await replaceAppointment(db, { runId: run.id, version: run.version, ...edit }, seeded.adminId);
    expect(replaced.ok).toBe(true);
    const relocked = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(relocked.ok).toBe(true);

    const supplier = seeded.suppliers.find((s) => s.id === edit.supplierId)!;
    const expected = [
      recipientKey("buyer", edit.removeBuyerId),
      recipientKey("buyer", edit.addBuyerId),
      recipientKey("supplier_admin", supplier.id),
      ...(supplier.attendeeContactEmail ? [recipientKey("supplier_attendee", supplier.id)] : []),
    ].sort();
    expect([...(await changedSinceLastSend(db, seeded.eventId))].sort()).toEqual(expected);
    expect(await countChangedSinceLastSend(db, seeded.eventId)).toBe(expected.length);

    const update = await newDraft("update");
    expect(update).toMatchObject({ kind: "update", audience: "changed_since_last_send", replyTo: "desk@da.example.com" });
    expect(update.htmlBody).toContain("Your AW appointment schedule has changed. Open your updated schedule: {{schedule_link}}");
    clearLoggedEmails();
    const sent = await sendCampaign(db, { campaignId: update.id, adminId: seeded.adminId });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.data).toMatchObject({ recipients: expected.length, sent: expected.length, eventAdvanced: true });
    const rows = await messagesOf(update.id);
    expect(rows.map((m) => recipientKey(m.contactType, m.entityId)).sort()).toEqual(expected);
    expect(await countChangedSinceLastSend(db, seeded.eventId)).toBe(0);

    // Nobody is left to update.
    const empty = await newDraft("update");
    const refused = await sendCampaign(db, { campaignId: empty.id, adminId: seeded.adminId });
    expect(!refused.ok && refused.error.message).toMatch(/Nobody's schedule changed/);
    const [still] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, empty.id));
    expect(still.status).toBe("draft");
  });
});

describe("batches", () => {
  it("sends in chunks of 100 and marks only a refused chunk as failed", async () => {
    const big = await seedEvent(db, { buyers: 120 });
    const run = await startRun(db, { eventId: big.eventId, adminId: big.adminId, keepExisting: false });
    if (!run.ok) throw new Error(run.error.message);
    const locked = await lockSchedule(db, { eventId: big.eventId, adminId: big.adminId });
    if (!locked.ok) throw new Error(locked.error.message);
    const created = await createCampaign(db, { eventId: big.eventId, adminId: big.adminId });
    if (!created.ok) throw new Error(created.error.message);

    const batch = vi.mocked(sendBatch);
    batch.mockClear();
    const real = batch.getMockImplementation()!;
    batch.mockImplementationOnce(real).mockRejectedValueOnce(new Error("Resend is down"));
    const result = await sendCampaign(db, { campaignId: created.data.id, adminId: big.adminId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 120 buyers + 6 supplier admins + 3 attendees
    expect(result.data).toMatchObject({ recipients: 129, sent: 100, failed: 29 });
    expect(batch.mock.calls.map((call) => call[0].length)).toEqual([100, 29]);
    const rows = await messagesOf(created.data.id);
    const failed = rows.filter((m) => m.status === "failed");
    expect(failed).toHaveLength(29);
    expect(failed[0].events[0]).toMatchObject({ type: "failed", detail: "Resend is down" });
    const detail = await getCampaign(created.data.id, db);
    expect(detail?.messages.find((m) => m.status === "failed")?.reason).toBe("Resend is down");

    // Failed messages count for "Resend to bounced".
    const retry = await resendToBounced(db, { campaignId: created.data.id, adminId: big.adminId });
    expect(retry.ok && retry.data).toMatchObject({ recipients: 29, sent: 29 });
  });
});

describe("a send that stops", () => {
  it("marks the campaign failed with the reason, and resend reaches everyone it missed", async () => {
    const other = await seedEvent(db);
    const run = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!run.ok) throw new Error(run.error.message);
    const locked = await lockSchedule(db, { eventId: other.eventId, adminId: other.adminId });
    if (!locked.ok) throw new Error(locked.error.message);
    const created = await createCampaign(db, { eventId: other.eventId, adminId: other.adminId });
    if (!created.ok) throw new Error(created.error.message);

    vi.mocked(scheduleHashesForEvent).mockRejectedValueOnce(new Error("connection reset"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendCampaign(db, { campaignId: created.data.id, adminId: other.adminId });
    error.mockRestore();
    expect(!result.ok && result.error.message).toContain("connection reset");

    const [stored] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, created.data.id));
    expect(stored.status).toBe("failed");
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "email.send"), eq(auditEvents.entityId, created.data.id)));
    expect(audit.after).toMatchObject({ status: "failed", failureReason: "connection reset" });
    expect(await messagesOf(created.data.id)).toHaveLength(0);

    clearLoggedEmails();
    const retry = await resendToBounced(db, { campaignId: created.data.id, adminId: other.adminId });
    expect(retry.ok && retry.data).toMatchObject({ recipients: stored.recipientCount, sent: stored.recipientCount });
    expect(getLoggedEmails()).toHaveLength(stored.recipientCount!);
    const [after] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, created.data.id));
    expect(after.status).toBe("sent");
  });
});

describe("webhook handler", () => {
  const secretBytes = Buffer.from("aw-test-webhook-secret-32-bytes!!");
  const secret = `whsec_${secretBytes.toString("base64")}`;

  function signed(body: unknown, id = `msg_${Math.random().toString(36).slice(2)}`) {
    const payload = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${payload}`).digest("base64");
    return { payload, headers: { id, timestamp, signature: `v1,${signature}` } };
  }

  it("verifies the signature, records the event, and refuses forgeries", async () => {
    const [message] = await db.select().from(emailMessages).where(eq(emailMessages.status, "sent")).limit(1);
    const body = {
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: message.providerMessageId, to: [message.toEmail], subject: "x", from: "x", created_at: "x" },
    };
    const request = signed(body);
    const options = { secret, isProduction: true };
    expect(await handleResendWebhook(db, request, options)).toEqual({ status: 200, body: "recorded" });
    expect(await handleResendWebhook(db, request, options)).toEqual({ status: 200, body: "duplicate" });
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, message.id));
    expect(row.status).toBe("delivered");

    const forged = { ...request, payload: request.payload.replace("delivered", "bounced") };
    expect((await handleResendWebhook(db, forged, options)).status).toBe(401);
    const unsigned = { ...request, headers: { ...request.headers, signature: null } };
    expect((await handleResendWebhook(db, unsigned, options)).status).toBe(401);
    const ignored = signed({ type: "contact.created", created_at: "x", data: { id: "c" } });
    expect(await handleResendWebhook(db, ignored, options)).toEqual({ status: 200, body: "Ignored." });
  });

  it("skips without a secret in development and fails loudly in production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = { payload: "{}", headers: { id: null, timestamp: null, signature: null } };
    expect((await handleResendWebhook(db, request, { secret: undefined, isProduction: false })).status).toBe(200);
    expect(warn).toHaveBeenCalledOnce();
    expect((await handleResendWebhook(db, request, { secret: undefined, isProduction: true })).status).toBe(500);
    warn.mockRestore();
  });
});
