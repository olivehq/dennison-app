import { eq, isNull } from "drizzle-orm";
import { and } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import {
  accessTokens,
  appointments,
  auditEvents,
  emailCampaigns,
  emailMessages,
  events,
  imports,
  nameAliases,
  participants,
  pendingFileDeletions,
  rankings,
  suppliers,
} from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { failNextDeletesForTests, getFile, importFileKey, putFile, useMemoryStorageForTests } from "@/lib/storage";
import { listAudit, recordAudit } from "@/server/audit/audit";
import { drainFileDeletions } from "@/server/files/cleanup";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { lockSchedule } from "@/server/schedule/lock";
import { archiveEvent, setRetainData } from "./events";
import { wasParticipantDataDeleted } from "./queries";
import {
  deleteExpiredParticipantData,
  retentionDeadline,
  retentionDeleteDate,
  STALE_SEND_HOURS,
  STALE_SEND_REASON,
} from "./retention";
import { raceBeforeTransaction } from "./test-race";

let db: Db;

/** A seeded, matched, locked event with an uploaded file, an alias, and one email. */
async function fullEvent(settings: { retainData?: boolean } = {}): Promise<Seeded & { fileKey: string }> {
  const seeded = await seedEvent(db, { settings });
  const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
  if (!run.ok) throw new Error(run.error.message);
  const locked = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
  if (!locked.ok) throw new Error(locked.error.message);

  const [upload] = await db
    .insert(imports)
    .values({ eventId: seeded.eventId, kind: "participants", fileKey: "pending", fileName: "Buyers.csv", status: "applied" })
    .returning();
  const fileKey = importFileKey(seeded.eventId, upload.id, "Buyers.csv");
  await putFile({ key: fileKey, body: Buffer.from("email\nbuyer0@example.com"), contentType: "text/csv" });
  await db.update(imports).set({ fileKey }).where(eq(imports.id, upload.id));
  await db.insert(nameAliases).values({
    eventId: seeded.eventId,
    rawText: "Buyer Zero",
    entityType: "buyer",
    entityId: seeded.buyers[0].id,
    source: "manual",
  });
  const [campaign] = await db
    .insert(emailCampaigns)
    .values({
      eventId: seeded.eventId,
      name: "Your schedule",
      fromName: "D&A",
      fromEmail: "schedule@example.com",
      replyTo: "staff@example.com",
      subject: "Your schedule",
      htmlBody: "<p>Hi {{first_name}}</p>",
      audience: "all",
      kind: "initial",
    })
    .returning();
  await db.insert(emailMessages).values({
    campaignId: campaign.id,
    eventId: seeded.eventId,
    contactType: "buyer",
    entityId: seeded.buyers[0].id,
    recipientName: "Buyer0 Person",
    toEmail: "buyer0@example.com",
    status: "delivered",
  });
  return { ...seeded, fileKey };
}

async function countFor(eventId: string) {
  const n = async (table: typeof participants | typeof suppliers | typeof rankings | typeof appointments | typeof accessTokens | typeof emailMessages | typeof imports | typeof nameAliases) =>
    (await db.select().from(table).where(eq(table.eventId, eventId))).length;
  return {
    participants: await n(participants),
    suppliers: await n(suppliers),
    rankings: await n(rankings),
    appointments: await n(appointments),
    accessTokens: await n(accessTokens),
    emailMessages: await n(emailMessages),
    imports: await n(imports),
    nameAliases: await n(nameAliases),
  };
}

beforeAll(async () => {
  db = await createTestDb();
  useMemoryStorageForTests();
});

describe("retention dates", () => {
  it("is due after the 90th day ends in the event timezone; the cron deletes the day after", () => {
    // Nov 10 + 90 days = Feb 8, 2027; it ends at 08:00 UTC on Feb 9 in Los Angeles.
    expect(retentionDeadline({ eventDate: "2026-11-10", timezone: "America/Los_Angeles" }).toISOString()).toBe(
      "2027-02-09T08:00:00.000Z",
    );
    expect(retentionDeleteDate("2026-11-10")).toBe("2027-02-09");
  });
});

describe("deleteExpiredParticipantData", () => {
  it("deletes participant data of due events, archives them, audits, and leaves the rest alone", async () => {
    const due = await fullEvent();
    const kept = await fullEvent({ retainData: true });
    const recent = await seedEvent(db);
    await db.update(events).set({ eventDate: "2027-01-15" }).where(eq(events.id, recent.eventId));
    await recordAudit(db, {
      eventId: due.eventId,
      adminId: due.adminId,
      action: "event.retention",
      entityType: "event",
      entityId: due.eventId,
      before: { retainData: true },
      after: { retainData: false },
    });
    // Cross-year aliases (D76): the due event's buyer alias goes, a supplier alias and another event's buyer alias stay.
    const globalAlias = (entityType: "buyer" | "supplier", entityId: string, rawText: string) =>
      db
        .insert(nameAliases)
        .values({ eventId: null, rawText, entityType, entityId, canonicalName: rawText, source: "manual" })
        .returning()
        .then(([row]) => row);
    const dueGlobal = await globalAlias("buyer", due.buyers[0].id, "B. Zero");
    const supplierGlobal = await globalAlias("supplier", due.suppliers[0].id, "Hyatt Monterey");
    const keptGlobal = await globalAlias("buyer", kept.buyers[0].id, "K. Zero");
    const before = await countFor(due.eventId);
    expect(before.participants).toBe(12);
    expect(before.accessTokens).toBe(21);

    expect(await wasParticipantDataDeleted(due.eventId, db)).toBe(false);
    // One minute before the deadline nothing happens.
    expect(await deleteExpiredParticipantData(db, new Date("2027-02-09T07:59:00Z"))).toEqual([]);

    const results = await deleteExpiredParticipantData(db, new Date("2027-02-09T09:00:00Z"));
    expect(results.map((r) => r.eventId)).toEqual([due.eventId]);
    expect(results[0].deleted).toMatchObject({
      participants: 12,
      suppliers: 6,
      rankings: before.rankings,
      appointments: before.appointments,
      accessTokens: 21,
      emailMessages: 1,
      imports: 1,
      files: 1,
      nameAliases: 2,
      matchRuns: 1,
    });
    expect(results[0].deleted.auditRowsRedacted).toBeGreaterThan(0);

    expect(await countFor(due.eventId)).toEqual({
      participants: 0,
      suppliers: 0,
      rankings: 0,
      appointments: 0,
      accessTokens: 0,
      emailMessages: 0,
      imports: 0,
      nameAliases: 0,
    });
    expect(await getFile(due.fileKey)).toBeNull();
    expect(await db.select().from(pendingFileDeletions).where(eq(pendingFileDeletions.storageKey, due.fileKey))).toHaveLength(0);
    const globals = (await db.select().from(nameAliases).where(isNull(nameAliases.eventId))).map((a) => a.id);
    expect(globals).not.toContain(dueGlobal.id);
    expect(globals).toEqual(expect.arrayContaining([supplierGlobal.id, keptGlobal.id]));
    const [archived] = await db.select().from(events).where(eq(events.id, due.eventId));
    expect(archived.status).toBe("archived");
    expect(await wasParticipantDataDeleted(due.eventId, db)).toBe(true);
    expect(await wasParticipantDataDeleted(kept.eventId, db)).toBe(false);

    const log = await listAudit({ eventId: due.eventId }, db);
    expect(log.rows[0]).toMatchObject({ action: "event.retention_delete", adminId: null });
    expect(log.rows[0].after).toMatchObject({ status: "archived", deleted: { participants: 12 } });
    const older = await db.select().from(auditEvents).where(eq(auditEvents.eventId, due.eventId));
    const personal = older.filter((r) => !r.action.startsWith("event."));
    expect(personal.length).toBeGreaterThan(0);
    expect(personal.every((r) => r.before === null && r.after === null && r.note === null)).toBe(true);
    expect(older.find((r) => r.action === "event.retention")?.after).toEqual({ retainData: false });
    const lockRow = older.find((r) => r.action === "schedule.lock");
    expect(lockRow?.after).toBeNull();

    expect((await countFor(kept.eventId)).participants).toBe(12);
    expect(await getFile(kept.fileKey)).not.toBeNull();
    expect((await countFor(recent.eventId)).participants).toBe(12);

    // The next daily run finds nothing to do and keeps the first run's audit row as it was.
    expect(await deleteExpiredParticipantData(db, new Date("2027-02-10T09:00:00Z"))).toEqual([]);
    const again = await listAudit({ eventId: due.eventId, filters: { action: "event.retention_delete" } }, db);
    expect(again.total).toBe(1);
    expect(again.rows[0].after).toMatchObject({ deleted: { participants: 12 } });
  });

  it("rechecks retainData under the row lock and skips an event that no longer qualifies", async () => {
    const event = await fullEvent();
    const before = await countFor(event.eventId);
    // D&A's "keep the data" lands after the cron read the due list, before it deletes.
    const raced = raceBeforeTransaction(db, () => setRetainData(db, event.eventId, true, event.adminId));
    const results = await deleteExpiredParticipantData(raced, new Date("2027-02-10T09:00:00Z"));
    expect(results.map((r) => r.eventId)).not.toContain(event.eventId);
    expect(await countFor(event.eventId)).toEqual(before);
    expect((await db.select().from(events).where(eq(events.id, event.eventId)))[0].status).toBe("locked");
    expect(await getFile(event.fileKey)).not.toBeNull();
    expect((await listAudit({ eventId: event.eventId, filters: { action: "event.retention_delete" } }, db)).total).toBe(0);
  });

  it("skips an event while one of its campaigns is sending and deletes it on a later run", async () => {
    const event = await fullEvent();
    const before = await countFor(event.eventId);
    const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.eventId, event.eventId));
    // Claimed an hour before the run: a send that may still be going.
    await db
      .update(emailCampaigns)
      .set({ status: "sending", updatedAt: new Date("2027-02-10T08:00:00Z") })
      .where(eq(emailCampaigns.id, campaign.id));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skipped = await deleteExpiredParticipantData(db, new Date("2027-02-10T09:00:00Z"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`event ${event.eventId}: skipped, an email send is in progress`));
    warn.mockRestore();
    expect(skipped.map((r) => r.eventId)).not.toContain(event.eventId);
    expect((await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id)))[0].status).toBe("sending");
    expect(await countFor(event.eventId)).toEqual(before);
    expect((await db.select().from(events).where(eq(events.id, event.eventId)))[0].status).toBe("locked");

    // The send finished; the next daily run deletes as usual.
    await db.update(emailCampaigns).set({ status: "sent" }).where(eq(emailCampaigns.id, campaign.id));
    const later = await deleteExpiredParticipantData(db, new Date("2027-02-11T09:00:00Z"));
    expect(later.map((r) => r.eventId)).toContain(event.eventId);
    expect((await countFor(event.eventId)).participants).toBe(0);
  });

  it("queues the import files in its transaction, so a failed delete survives to the next run", async () => {
    const event = await fullEvent();
    const queued = () => db.select().from(pendingFileDeletions).where(eq(pendingFileDeletions.storageKey, event.fileKey));

    failNextDeletesForTests();
    const results = await deleteExpiredParticipantData(db, new Date("2027-02-12T09:00:00Z"));
    expect(results.map((r) => r.eventId)).toContain(event.eventId);
    // The import row is gone, but the queue still knows the file.
    expect(await countFor(event.eventId)).toMatchObject({ imports: 0 });
    expect(await getFile(event.fileKey)).not.toBeNull();
    expect(await queued()).toMatchObject([{ attempts: 1 }]);

    // The next cron run: nothing left to delete in the database, the file goes.
    expect(await deleteExpiredParticipantData(db, new Date("2027-02-13T09:00:00Z"))).toEqual([]);
    expect(await drainFileDeletions(db, { now: new Date("2027-02-13T09:00:00Z") })).toMatchObject({ deleted: 1, pending: 0 });
    expect(await getFile(event.fileKey)).toBeNull();
    expect(await queued()).toEqual([]);
  });
});

describe("stale sends and empty archived events", () => {
  it(`marks a campaign sending for more than ${STALE_SEND_HOURS} hours failed, with a reason, and deletes the event`, async () => {
    const event = await fullEvent();
    const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.eventId, event.eventId));
    const now = new Date("2027-02-10T09:00:00Z");
    await db
      .update(emailCampaigns)
      .set({ status: "sending", updatedAt: new Date(now.getTime() - (STALE_SEND_HOURS + 1) * 60 * 60 * 1000) })
      .where(eq(emailCampaigns.id, campaign.id));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await deleteExpiredParticipantData(db, now);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`campaign ${campaign.id} was stuck sending`));
    warn.mockRestore();
    expect(results.map((r) => r.eventId)).toContain(event.eventId);
    expect((await countFor(event.eventId)).participants).toBe(0);
    expect((await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaign.id)))[0].status).toBe("failed");
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "email.send"), eq(auditEvents.entityId, campaign.id)));
    expect(audit).toMatchObject({ adminId: null, after: { status: "failed", failureReason: STALE_SEND_REASON } });
  });

  it("records the deletion once for an overdue archived event that has nothing to delete", async () => {
    // Archived by hand with no participant data at all (as if never imported).
    const event = await seedEvent(db, { status: "archived" });
    await db.delete(rankings).where(eq(rankings.eventId, event.eventId));
    await db.delete(participants).where(eq(participants.eventId, event.eventId));
    await db.delete(suppliers).where(eq(suppliers.eventId, event.eventId));
    expect(await wasParticipantDataDeleted(event.eventId, db)).toBe(false);

    const first = await deleteExpiredParticipantData(db, new Date("2027-02-10T09:00:00Z"));
    expect(first.find((r) => r.eventId === event.eventId)?.deleted.participants).toBe(0);
    // The settings card now says the data is gone instead of "at the next daily cleanup".
    expect(await wasParticipantDataDeleted(event.eventId, db)).toBe(true);

    const second = await deleteExpiredParticipantData(db, new Date("2027-02-11T09:00:00Z"));
    expect(second.map((r) => r.eventId)).not.toContain(event.eventId);
    const rows = await listAudit({ eventId: event.eventId, filters: { action: "event.retention_delete" } }, db);
    expect(rows.total).toBe(1);
  });
});

describe("wasParticipantDataDeleted", () => {
  it("is false for an event an admin archived by hand", async () => {
    const event = await seedEvent(db);
    // Not yet due, so other tests' retention runs leave it alone.
    await db.update(events).set({ eventDate: "2099-01-15" }).where(eq(events.id, event.eventId));
    expect((await archiveEvent(db, { eventId: event.eventId, adminId: event.adminId })).ok).toBe(true);
    expect(await wasParticipantDataDeleted(event.eventId, db)).toBe(false);
  });
});
