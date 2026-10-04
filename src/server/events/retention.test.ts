import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
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
  rankings,
  suppliers,
} from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { getFile, importFileKey, putFile, useMemoryStorageForTests } from "@/lib/storage";
import { listAudit, recordAudit } from "@/server/audit/audit";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { lockSchedule } from "@/server/schedule/lock";
import { deleteExpiredParticipantData, retentionDeadline, retentionDeleteDate } from "./retention";

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
    const before = await countFor(due.eventId);
    expect(before.participants).toBe(12);
    expect(before.accessTokens).toBe(21);

    // One minute before the deadline nothing happens.
    expect(await deleteExpiredParticipantData(db, new Date("2027-02-09T07:59:00Z"))).toEqual([]);

    const results = await deleteExpiredParticipantData(db, new Date("2027-02-09T09:00:00Z"));
    expect(results.map((r) => r.eventId)).toEqual([due.eventId]);
    expect(results[0].fileErrors).toEqual([]);
    expect(results[0].deleted).toMatchObject({
      participants: 12,
      suppliers: 6,
      rankings: before.rankings,
      appointments: before.appointments,
      accessTokens: 21,
      emailMessages: 1,
      imports: 1,
      files: 1,
      nameAliases: 1,
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
    const [archived] = await db.select().from(events).where(eq(events.id, due.eventId));
    expect(archived.status).toBe("archived");

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
});
