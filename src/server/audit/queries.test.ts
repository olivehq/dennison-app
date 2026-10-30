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
  const [first] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.runId, runId))
    .orderBy(appointments.slot, appointments.supplierId, appointments.buyerId)
    .limit(1);
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

  it("names people by their own name on roster rows and by the organization label on schedule rows", async () => {
    // Buyer 0 has an organization and title, so the schedule calls them "Org 0 - Title 0".
    const buyer = seeded.buyers[0];
    await recordAudit(db, {
      eventId: seeded.eventId,
      adminId: seeded.adminId,
      action: "participant.withdraw",
      entityType: "participant",
      entityId: buyer.id,
      before: { status: "active" },
      after: { status: "withdrawn" },
    });
    const { auditEventId } = await removeFirst();
    const page = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    expect(page.rows.find((r) => r.action === "participant.withdraw")!.sentence).toBe("Withdrew Buyer0 Person");
    expect(page.rows.find((r) => r.id === auditEventId)!.sentence).toMatch(/^Removed (Org \d+ - Title \d+|Buyer\d+ Person) from /);
    expect(page.people.find((p) => p.value === buyer.id)!.label).toBe("Org 0 - Title 0");
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

  it("disables undo with the reason when a later change refilled the slot, matching what undo would say", async () => {
    // Pick a meeting whose slot can be refilled by another buyer at the same
    // desk, remove it, then block the undo with that later meeting. Inserted
    // directly: this test is about undo's conflict check, not about who may be
    // added, and which meetings the seeded run has depends on its random ids.
    const all = await db
      .select()
      .from(appointments)
      .where(eq(appointments.runId, runId))
      .orderBy(appointments.slot, appointments.supplierId, appointments.buyerId);
    const blockerFor = (m: (typeof all)[number]) =>
      seeded.buyers.find(
        (b) =>
          b.id !== m.buyerId &&
          !all.some((a) => a.slot === m.slot && a.buyerId === b.id) &&
          !all.some((a) => a.buyerId === b.id && a.supplierId === m.supplierId),
      );
    const first = all.find((m) => blockerFor(m) !== undefined)!;
    expect(first).toBeDefined();
    const blocker = blockerFor(first)!;
    const run = await getActiveRun(seeded.eventId, db);
    const removed = await removeAppointment(
      db,
      { runId, version: run!.version, slot: first.slot, supplierId: first.supplierId, buyerId: first.buyerId },
      seeded.adminId,
    );
    if (!removed.ok) throw new Error(removed.error.message);
    const { auditEventId } = removed.data;
    await db
      .insert(appointments)
      .values({ runId, eventId: seeded.eventId, slot: first.slot, supplierId: first.supplierId, buyerId: blocker.id, source: "manual" });

    const page = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    const undo = page.rows.find((r) => r.id === auditEventId)!.undo;
    const attempt = await undoAudit(db, { auditEventId, adminId: seeded.adminId });
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(undo).toEqual({ available: false, reason: attempt.error.message });
    expect(attempt.error.message).toMatch(/already has .+ in slot \d+\. Move or remove that meeting first, then undo again\.$/);
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

describe("getActivityPage summary", () => {
  it("counts today's changes in the event timezone with the same filters its shortcuts apply", async () => {
    await removeFirst();
    const page = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    const { summary } = page;
    const today = (await getActivityPage(seeded.eventId, { page: 1, from: summary.today, to: summary.today }, db))!;
    const schedule = (await getActivityPage(seeded.eventId, { page: 1, type: "schedule", from: summary.today, to: summary.today }, db))!;
    expect(summary.changes).toBe(today.total);
    expect(summary.changes).toBeGreaterThan(1);
    expect(summary.scheduleEdits).toBe(schedule.total);
    expect(summary.scheduleEdits).toBe(1);
    expect(summary.imports).toBe(0);
    expect(summary.admins).toEqual([{ id: seeded.adminId, name: "Test Admin" }]);
    expect(page.rows[0]).toMatchObject({ day: summary.today, area: "schedule", action: "appointment.remove" });
    expect(page.rows[0].time).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
  });

  it("counts imports and schedule edits in one pass and matches the filtered lists", async () => {
    await removeFirst();
    for (const action of ["import.commit", "alias.create", "participant.update"]) {
      await recordAudit(db, { eventId: seeded.eventId, adminId: seeded.adminId, action, entityType: "x" });
    }
    const { summary } = (await getActivityPage(seeded.eventId, { page: 1 }, db))!;
    const range = { from: summary.today, to: summary.today };
    const imports = (await getActivityPage(seeded.eventId, { page: 1, type: "imports", ...range }, db))!;
    const schedule = (await getActivityPage(seeded.eventId, { page: 1, type: "schedule", ...range }, db))!;
    const all = (await getActivityPage(seeded.eventId, { page: 1, ...range }, db))!;
    expect(summary.imports).toBe(2);
    expect(summary.imports).toBe(imports.total);
    expect(summary.scheduleEdits).toBe(schedule.total);
    expect(summary.changes).toBe(all.total);
  });

  it("reads today's counts with one query instead of a row and count query for each tile", async () => {
    let selects = 0;
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") selects += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    await getActivityPage(seeded.eventId, { page: 1 }, counting);
    // Event, list rows, list count, buyers, suppliers, admins, active run, and the one summary count.
    // The three tiles used to cost a row and a count query each (13 in all).
    expect(selects).toBe(8);
  });

  it("decides today from the event's clock, not UTC", async () => {
    // 11:30 PM Nov 10 in Los Angeles; "now" is 12:30 AM Nov 11 there.
    const [late] = await recordAuditAt("2026-11-11T07:30:00Z");
    const page = (await getActivityPage(seeded.eventId, { page: 1, from: "2026-11-10", to: "2026-11-10" }, db, new Date("2026-11-11T08:30:00Z")))!;
    expect(page.summary).toMatchObject({ today: "2026-11-11", yesterday: "2026-11-10", changes: 0, scheduleEdits: 0, admins: [] });
    expect(page.rows.map((r) => [r.id, r.day, r.time, r.area])).toEqual([[late.id, "2026-11-10", "11:30 PM", "settings"]]);
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
