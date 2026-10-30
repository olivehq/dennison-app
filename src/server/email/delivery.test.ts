import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { auditEvents, emailCampaigns, emailMessages, type EmailCampaign } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { decryptToken } from "@/lib/tokens";
import { EmailRejectedError, sendBatch, type EmailMessage, type SentEmail } from "@/lib/email/adapter";
import { archiveEvent } from "@/server/events/events";
import { hasSendInProgress, SEND_IN_PROGRESS_MESSAGE } from "@/server/events/status";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { lockSchedule, unlockSchedule } from "@/server/schedule/lock";
import { STALE_SEND_HOURS, STALE_SEND_REASON, transitionCampaign } from "./campaign-status";
import { createCampaign, resendToBounced, sendCampaign } from "./campaigns";
import { deliverCampaign, isResendable, retryRecipients, RETRY_WINDOW_HOURS } from "./delivery";
import { resolveAudience, type Recipient } from "./recipients";
import { recordDeliveryEvent } from "./webhook";

vi.mock("@/lib/email/adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/adapter")>();
  return { ...actual, sendBatch: vi.fn(actual.sendBatch) };
});

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

type Answer = "accept" | "lose-response" | "reject";

/**
 * A provider that keeps idempotency keys as Resend does: a key it has seen
 * gets the first answer back and nothing is sent again. `plan` says how each
 * new batch is answered; "lose-response" sends it, then throws as a dropped
 * connection would.
 */
function fakeProvider(plan: Answer[]) {
  const sent: EmailMessage[] = [];
  const keys: string[] = [];
  const answers = new Map<string, SentEmail[]>();
  const payloads = new Map<string, string>();
  let counter = 0;
  vi.mocked(sendBatch).mockImplementation(async (messages, { idempotencyKey }) => {
    keys.push(idempotencyKey);
    const earlier = answers.get(idempotencyKey);
    if (earlier) {
      // Resend refuses a known key with a different payload.
      if (payloads.get(idempotencyKey) !== JSON.stringify(messages)) throw new Error("409 invalid_idempotent_request");
      return earlier;
    }
    payloads.set(idempotencyKey, JSON.stringify(messages));
    const answer = plan.shift() ?? "accept";
    if (answer === "reject") throw new EmailRejectedError("Resend rejected the batch: The from address is not verified.");
    const ids = messages.map(() => ({ id: `fake-${++counter}` }));
    sent.push(...messages);
    answers.set(idempotencyKey, ids);
    if (answer === "lose-response") throw new Error("socket hang up");
    return ids;
  });
  return { sent, keys };
}

beforeEach(() => {
  vi.mocked(sendBatch).mockReset();
});

/** A locked event with one draft campaign and its recipients, links issued. */
async function lockedCampaign(): Promise<{ seeded: Seeded; campaign: EmailCampaign; recipients: Recipient[] }> {
  const seeded = await seedEvent(db);
  const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
  if (!run.ok) throw new Error(run.error.message);
  const locked = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
  if (!locked.ok) throw new Error(locked.error.message);
  const created = await createCampaign(db, { eventId: seeded.eventId, adminId: seeded.adminId });
  if (!created.ok) throw new Error(created.error.message);
  const resolved = await resolveAudience(db, seeded.eventId, "all", [], { links: "issue" });
  if (!resolved.ok) throw new Error(resolved.error.message);
  return { seeded, campaign: created.data, recipients: resolved.data };
}

async function messagesOf(campaignId: string) {
  return db.select().from(emailMessages).where(eq(emailMessages.campaignId, campaignId));
}

function quietly<T>(work: () => Promise<T>): Promise<T> {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return work().finally(() => {
    error.mockRestore();
    warn.mockRestore();
  });
}

describe("a batch with no answer from the provider", () => {
  it("stays queued with its hand-off time and key, and a retry under the same key sends nothing twice", async () => {
    const { campaign, recipients } = await lockedCampaign();
    const provider = fakeProvider(["lose-response"]);

    const first = await quietly(() => deliverCampaign(db, campaign, recipients));
    expect(first).toMatchObject({ sent: 0, failed: 0, uncertain: recipients.length });
    expect(provider.sent).toHaveLength(recipients.length);
    const rows = await messagesOf(campaign.id);
    expect(rows.every((m) => m.status === "queued" && m.sentAt && m.batchKey === rows[0].batchKey)).toBe(true);
    expect(rows[0].events.at(-1)).toMatchObject({ type: "unconfirmed", detail: "socket hang up" });
    // The saved request holds schedule links, so it is stored encrypted: not JSON, but it decrypts to the email.
    for (const m of rows) {
      expect(() => JSON.parse(m.request!)).toThrow();
      expect(JSON.parse(decryptToken(m.request!)!).email.to).toBe(m.toEmail);
    }
    expect(rows.every((m) => isResendable(m))).toBe(true);

    const retry = await retryRecipients(db, campaign, recipients);
    expect(retry).toMatchObject({ sent: recipients.length, failed: 0, uncertain: 0 });
    expect(provider.keys).toHaveLength(2);
    expect(provider.keys[1]).toBe(provider.keys[0]);
    // The provider answered the known key with the first ids and sent nothing again.
    expect(provider.sent).toHaveLength(recipients.length);
    const after = await messagesOf(campaign.id);
    expect(after).toHaveLength(recipients.length);
    expect(after.every((m) => m.status === "sent" && m.providerMessageId?.startsWith("fake-"))).toBe(true);
    // Answered, so never retried again: the saved request is gone.
    expect(after.every((m) => m.request === null)).toBe(true);
  });

  it("is retried by Retry delivery, which keeps the key, and the campaign ends sent", async () => {
    const { seeded, campaign, recipients } = await lockedCampaign();
    const provider = fakeProvider(["lose-response"]);

    const send = await quietly(() => sendCampaign(db, { campaignId: campaign.id, adminId: seeded.adminId }));
    expect(send.ok && send.data).toMatchObject({ recipients: recipients.length, sent: 0, failed: recipients.length });
    const [failedCampaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id));
    expect(failedCampaign.status).toBe("failed");
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "email.send"), eq(auditEvents.entityId, campaign.id)));
    expect(audit.after).toMatchObject({ status: "failed", uncertain: recipients.length });

    const resend = await resendToBounced(db, { campaignId: campaign.id, adminId: seeded.adminId });
    expect(resend.ok && resend.data).toMatchObject({ recipients: recipients.length, sent: recipients.length, failed: 0 });
    expect(new Set(provider.keys).size).toBe(1);
    expect(provider.sent).toHaveLength(recipients.length);
    const [after] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id));
    expect(after.status).toBe("sent");
  });

  it("moves to delivered on a late webhook, and a retry then trusts the batch without calling the provider", async () => {
    const { campaign, recipients } = await lockedCampaign();
    const provider = fakeProvider(["lose-response"]);
    await quietly(() => deliverCampaign(db, campaign, recipients));
    const [first, ...rest] = await messagesOf(campaign.id);

    const outcome = await recordDeliveryEvent(db, {
      type: "delivered",
      providerMessageId: "fake-1",
      messageId: first.id,
      at: new Date().toISOString(),
      webhookId: "wh_late",
    });
    expect(outcome).toBe("recorded");
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, first.id));
    expect(row).toMatchObject({ status: "delivered", providerMessageId: "fake-1" });
    // The webhook proves the batch was taken, so its saved requests are cleared at once.
    expect((await messagesOf(campaign.id)).every((m) => m.request === null)).toBe(true);

    const others = recipients.filter((r) => r.entityId !== first.entityId || r.contactType !== first.contactType);
    const retry = await retryRecipients(db, campaign, others);
    expect(retry).toMatchObject({ sent: rest.length, uncertain: 0 });
    expect(provider.keys).toHaveLength(1);
    const after = await messagesOf(campaign.id);
    expect(after.filter((m) => m.status === "sent")).toHaveLength(rest.length);
  });

  it("is not sent again when a webhook delivers it after the caller picked it for a retry", async () => {
    const { campaign, recipients } = await lockedCampaign();
    const provider = fakeProvider(["lose-response"]);
    await quietly(() => deliverCampaign(db, campaign, recipients));
    const [first] = await messagesOf(campaign.id);
    // The caller read it as uncertain, then the webhook landed before retryRecipients read it again.
    await recordDeliveryEvent(db, {
      type: "delivered",
      providerMessageId: "fake-1",
      messageId: first.id,
      at: new Date().toISOString(),
      webhookId: "wh_race",
    });
    const picked = recipients.filter((r) => r.entityId === first.entityId && r.contactType === first.contactType);

    const retry = await retryRecipients(db, campaign, picked);
    expect(retry).toMatchObject({ sent: 0, failed: 0, uncertain: 0 });
    expect(provider.keys).toHaveLength(1);
    expect(provider.sent).toHaveLength(recipients.length);
    expect(await messagesOf(campaign.id)).toHaveLength(recipients.length);
  });

  it("is resent exactly as first handed over, even after a link changed, so the provider accepts the key", async () => {
    const { campaign, recipients } = await lockedCampaign();
    const provider = fakeProvider(["lose-response"]);
    await quietly(() => deliverCampaign(db, campaign, recipients));
    // A regenerated link changes the merge values; one recipient is no longer in the retry at all.
    const changed = recipients
      .slice(1)
      .map((r) => ({ ...r, mergeValues: { ...r.mergeValues, schedule_link: "https://example.com/s/new-token" } }));

    const retry = await retryRecipients(db, campaign, changed);
    expect(retry).toMatchObject({ sent: recipients.length, uncertain: 0 });
    expect(new Set(provider.keys).size).toBe(1);
    expect(provider.sent).toHaveLength(recipients.length);
    expect((await messagesOf(campaign.id)).every((m) => m.status === "sent")).toBe(true);
  });

  it(`is left alone after ${RETRY_WINDOW_HOURS} hours, when the provider may have forgotten the key`, () => {
    const now = new Date("2026-11-02T18:00:00Z");
    const handedOver = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
    const batchKey = "6f1c1f0e-3b7a-4a59-9a4e-2f1d6c0b8a11";
    expect(isResendable({ status: "queued", sentAt: handedOver(1), batchKey }, now)).toBe(true);
    expect(isResendable({ status: "queued", sentAt: handedOver(RETRY_WINDOW_HOURS), batchKey }, now)).toBe(false);
    // Handed over before batch keys existed: never retried, as before.
    expect(isResendable({ status: "queued", sentAt: handedOver(1), batchKey: null }, now)).toBe(false);
    expect(isResendable({ status: "queued", sentAt: null, batchKey: null }, now)).toBe(true);
  });
});

describe("a retry of an uncertain batch that the provider refuses", () => {
  it("stays uncertain, since the first attempt may have gone, so a later retry sends nobody twice", async () => {
    const { campaign, recipients } = await lockedCampaign();
    const provider = fakeProvider(["lose-response"]);
    await quietly(() => deliverCampaign(db, campaign, recipients));
    const firstKey = provider.keys[0];
    // The retry is refused before the provider looks at the key (a rotated API key, a lapsed domain).
    vi.mocked(sendBatch).mockRejectedValueOnce(new EmailRejectedError("Resend rejected the batch: API key is invalid"));

    const refused = await quietly(() => retryRecipients(db, campaign, recipients));
    expect(refused).toMatchObject({ sent: 0, failed: 0, uncertain: recipients.length });
    const rows = await messagesOf(campaign.id);
    expect(rows.every((m) => m.status === "queued" && m.batchKey && m.request)).toBe(true);

    const retry = await retryRecipients(db, campaign, recipients);
    expect(retry).toMatchObject({ sent: recipients.length, uncertain: 0 });
    expect(provider.keys.filter((k) => k === firstKey)).toHaveLength(2);
    expect(provider.sent).toHaveLength(recipients.length);
  });
});

describe("a batch the provider refused", () => {
  it("is marked failed, and a retry sends new messages under a new key", async () => {
    const { campaign, recipients } = await lockedCampaign();
    const provider = fakeProvider(["reject"]);

    const first = await quietly(() => deliverCampaign(db, campaign, recipients));
    expect(first).toMatchObject({ sent: 0, failed: recipients.length, uncertain: 0 });
    expect(provider.sent).toHaveLength(0);
    const rows = await messagesOf(campaign.id);
    expect(rows.every((m) => m.status === "failed" && m.sentAt === null)).toBe(true);
    expect(rows[0].events.at(-1)).toMatchObject({ type: "failed", detail: expect.stringContaining("not verified") });

    const retry = await retryRecipients(db, campaign, recipients);
    expect(retry).toMatchObject({ sent: recipients.length, failed: 0 });
    expect(provider.keys).toHaveLength(2);
    expect(provider.keys[1]).not.toBe(provider.keys[0]);
    expect(provider.sent).toHaveLength(recipients.length);
    expect(await messagesOf(campaign.id)).toHaveLength(recipients.length * 2);
  });
});

describe("campaign status moves", () => {
  it("are a compare-and-set, and a move the machine does not allow throws", async () => {
    const { campaign } = await lockedCampaign();
    expect(await transitionCampaign(db, campaign.id, "sent", "sending")).toBeNull();
    expect(await transitionCampaign(db, campaign.id, "draft", "sending")).toMatchObject({ status: "sending" });
    await expect(transitionCampaign(db, campaign.id, "draft", "sent")).rejects.toThrow(/can't move from draft to sent/);
    expect(await transitionCampaign(db, campaign.id, "sending", "draft")).toMatchObject({ status: "draft" });
  });
});

describe("a send stuck in sending", () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

  async function markSending(campaignId: string, since: Date) {
    await db.update(emailCampaigns).set({ status: "sending", updatedAt: since }).where(eq(emailCampaigns.id, campaignId));
  }

  async function repairAudit(campaignId: string) {
    return db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "email.send"), eq(auditEvents.entityId, campaignId)));
  }

  it(`still blocks unlock while fresh, and is marked failed with an audit row once older than ${STALE_SEND_HOURS} hours`, async () => {
    const { seeded, campaign } = await lockedCampaign();
    const input = { eventId: seeded.eventId, adminId: seeded.adminId, reason: "Fix a desk" };

    await markSending(campaign.id, hoursAgo(1));
    expect(await unlockSchedule(db, input)).toEqual({ ok: false, error: { code: "conflict", message: SEND_IN_PROGRESS_MESSAGE } });
    expect(await repairAudit(campaign.id)).toHaveLength(0);

    await markSending(campaign.id, hoursAgo(STALE_SEND_HOURS + 1));
    const unlocked = await quietly(() => unlockSchedule(db, input));
    expect(unlocked.ok).toBe(true);
    const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id));
    expect(row.status).toBe("failed");
    const audit = await repairAudit(campaign.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      eventId: seeded.eventId,
      adminId: null,
      entityType: "email_campaign",
      before: { status: "sending" },
      after: { status: "failed", failureReason: STALE_SEND_REASON },
    });
  });

  it("no longer blocks archive, and hasSendInProgress reports it gone", async () => {
    const { seeded, campaign } = await lockedCampaign();
    await markSending(campaign.id, hoursAgo(STALE_SEND_HOURS + 1));
    expect(await quietly(() => hasSendInProgress(db, seeded.eventId))).toBe(false);
    expect(await repairAudit(campaign.id)).toHaveLength(1);

    await markSending(campaign.id, hoursAgo(STALE_SEND_HOURS + 2));
    const archived = await quietly(() => archiveEvent(db, { eventId: seeded.eventId, adminId: seeded.adminId }));
    expect(archived.ok).toBe(true);
    expect(await repairAudit(campaign.id)).toHaveLength(2);
  });
});
