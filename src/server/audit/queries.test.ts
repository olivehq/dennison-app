import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, auditEvents, events } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { getActiveRun } from "@/server/matching/queries";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { removeAppointment, undoAudit } from "@/server/schedule/edits";
import { recordAudit } from "./audit";
import { auditDetails, getActivityPage, parseActivityParams } from "./queries";

let db: Db;
let seeded: Seeded;
let runId: string;

async function removeFirst() {
  const [first] = await db.select().from(appointments).where(eq(appointments.runId, runId)).limit(1);
  const run = await getActiveRun(seeded.eventId, db);
  const result = await removeAppointment(
    db,
    { runId, version: run!.version, slot: first.slot, supplierId: first.supplierId, buyerId: first.buyerId },
    seeded.adminId,
  );
  if (!result.ok) throw new Error(result.error.message);
  return { first, auditEventId: result.data.auditEventId };
}

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  seeded = await seedEvent(db);
  const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
  if (!run.ok) throw new Error(run.error.message);
  runId = run.data.runId;
});

describe("parseActivityParams", () => {
  it("keeps valid filters and drops the rest", () => {
    expect(
      parseActivityParams({ person: "nope", admin: "a1", type: "lock", from: "2026-11-10", to: "11/12/2026", page: "3" }),
    ).toEqual({ person: undefined, admin: "a1", type: "lock", from: "2026-11-10", to: undefined, page: 3 });
    expect(parseActivityParams({ type: "constructor", page: ["2"] })).toMatchObject({ type: undefined, page: 1 });
  });
});

describe("getActivityPage", () => {
  it("names people, offers undo on the active run, and marks undone rows", async () => {
    const { first, auditEventId } = await removeFirst();
    let page = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    const removal = page.rows.find((r) => r.id === auditEventId)!;
    expect(removal.sentence).toMatch(/^Removed .+ from .+, slot \d+$/);
    expect(removal.sentence).not.toContain(first.buyerId);
    expect(removal.who).toBe("Test Admin");
    expect(removal.undo).toEqual({ available: true });
    expect(removal.details.find((d) => d.key === "slot")).toEqual({ key: "slot", label: "Slot", before: String(first.slot), after: null });
    const run = page.rows.find((r) => r.sentence.startsWith("Ran matching"))!;
    expect(run.undo).toBeNull();
    expect(page.people).toHaveLength(18);
    expect(page.people[0].group).toBe("Buyers");

    const undone = await undoAudit(db, { auditEventId, adminId: seeded.adminId });
    expect(undone.ok).toBe(true);
    page = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    expect(page.rows[0].sentence).toMatch(/^Undid a removal/);
    expect(page.rows[0].undo).toEqual({ available: true });
    expect(page.rows.find((r) => r.id === auditEventId)!.undo).toEqual({
      available: false,
      reason: "This change was already undone.",
    });
  });

  it("disables undo while locked and for runs that are no longer active", async () => {
    const { auditEventId } = await removeFirst();
    await db.update(events).set({ status: "locked" }).where(eq(events.id, seeded.eventId));
    let page = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    expect(page.rows.find((r) => r.id === auditEventId)!.undo).toEqual({
      available: false,
      reason: "Unlock the schedule to undo changes.",
    });

    await db.update(events).set({ status: "matched" }).where(eq(events.id, seeded.eventId));
    const rerun = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!rerun.ok) throw new Error(rerun.error.message);
    const { activateRun } = await import("@/server/matching/runs");
    await activateRun(db, { runId: rerun.data.runId, adminId: seeded.adminId });
    page = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    expect(page.rows.find((r) => r.id === auditEventId)!.undo).toMatchObject({ available: false, reason: expect.stringMatching(/no longer active/) });
  });

  it("filters by type, person, and whole days in the event timezone", async () => {
    const { first } = await removeFirst();
    const schedule = (await getActivityPage(seeded.eventId, { page: 1, type: "schedule" }, db))!;
    expect(schedule.rows.map((r) => r.sentence.split(" ")[0])).toEqual(["Removed"]);
    const matching = (await getActivityPage(seeded.eventId, { page: 1, type: "matching" }, db))!;
    expect(matching.total).toBe(1);
    const person = (await getActivityPage(seeded.eventId, { page: 1, person: first.buyerId }, db))!;
    expect(person.total).toBe(1);

    // Pin one row at 11:30 PM Los Angeles time on Nov 10, which is Nov 11 in UTC.
    const [late] = await recordAuditAt("2026-11-11T07:30:00Z");
    const nov10 = (await getActivityPage(seeded.eventId, { page: 1, from: "2026-11-10", to: "2026-11-10" }, db))!;
    expect(nov10.rows.map((r) => r.id)).toEqual([late.id]);
    expect(nov10.rows[0].when).toBe("Nov 10, 2026, 11:30 PM");
    const nov11 = (await getActivityPage(seeded.eventId, { page: 1, from: "2026-11-11", to: "2026-11-11" }, db))!;
    expect(nov11.total).toBe(0);
  });
});

async function recordAuditAt(iso: string) {
  const row = await recordAudit(db, {
    eventId: seeded.eventId,
    adminId: seeded.adminId,
    action: "event.update",
    entityType: "event",
    entityId: seeded.eventId,
  });
  return db.update(auditEvents).set({ createdAt: new Date(iso) }).where(eq(auditEvents.id, row.id)).returning();
}

describe("auditDetails", () => {
  it("lines up before and after and hides bookkeeping keys", () => {
    const names = new Map([["s1", "Hyatt"]]);
    expect(auditDetails({ before: { runId: "r", supplierId: "s1", pinned: false }, after: { supplierId: "s1", pinned: true, slots: [1, 2] } }, names)).toEqual([
      { key: "supplierId", label: "Supplier", before: "Hyatt", after: "Hyatt" },
      { key: "pinned", label: "Pinned", before: "No", after: "Yes" },
      { key: "slots", label: "Slots", before: null, after: "2 items" },
    ]);
  });
});
