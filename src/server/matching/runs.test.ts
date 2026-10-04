import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { appointments, events, matchRuns, participants } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { VERSION_CONFLICT_MESSAGE } from "@/lib/schemas/schedule";
import { listAudit } from "@/server/audit/audit";
import { nameWarning } from "./common";
import { getActiveRun, getRun, listRuns } from "./queries";
import { activateRun, compareRuns, setPinned, startRun } from "./runs";
import { seedEvent, UUID_RE, type Seeded } from "./test-seed";

let db: Db;
let seeded: Seeded;
let firstRunId: string;
let secondRunId: string;

function key(a: { slot: number; buyerId: string; supplierId: string }) {
  return `${a.slot}:${a.buyerId}:${a.supplierId}`;
}

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
});

describe("startRun", () => {
  it("runs the engine, stores rows and stats, and activates the first run", async () => {
    const result = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    firstRunId = result.data.runId;
    expect(result.data.isActive).toBe(true);
    expect(result.data.stats.totalAppointments).toBeGreaterThan(0);
    expect(result.data.stats.totalSuppliers).toBe(6);
    expect(result.data.stats.totalBuyers).toBe(12);

    const rows = await db.select().from(appointments).where(eq(appointments.runId, firstRunId));
    expect(rows).toHaveLength(result.data.stats.totalAppointments);
    expect(rows.every((r) => r.source === "engine" && !r.pinned)).toBe(true);

    const run = await getRun(firstRunId, db);
    expect(run?.status).toBe("completed");
    expect(run?.isActive).toBe(true);
    expect(run?.durationMs).not.toBeNull();
    expect(run?.completedAt).not.toBeNull();
    expect(run?.stats?.thresholds.supplierTarget).toBe(9);
    expect(run?.settingsSnapshot.supplierTarget).toBe(9);
    for (const warning of run?.warnings ?? []) expect(warning).not.toMatch(UUID_RE);

    const [event] = await db.select().from(events).where(eq(events.id, seeded.eventId));
    expect(event.status).toBe("matched");

    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "matching.run" } }, db);
    expect(audit.total).toBe(1);
    expect(audit.rows[0].entityId).toBe(firstRunId);
  });

  it("does not activate later runs; activateRun switches the flags", async () => {
    const result = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    secondRunId = result.data.runId;
    expect(result.data.isActive).toBe(false);
    expect((await getActiveRun(seeded.eventId, db))?.id).toBe(firstRunId);

    const activated = await activateRun(db, { runId: secondRunId, adminId: seeded.adminId });
    expect(activated.ok).toBe(true);
    const runs = await listRuns(seeded.eventId, db);
    expect(runs.map((r) => [r.id, r.isActive])).toEqual([
      [secondRunId, true],
      [firstRunId, false],
    ]);
    expect(runs[0].summary?.totalAppointments).toBeGreaterThan(0);

    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "matching.activate" } }, db);
    expect(audit.rows[0].before).toEqual({ activeRunId: firstRunId });
    expect(audit.rows[0].after).toEqual({ activeRunId: secondRunId });
  });

  it("refuses keepExisting when the event has no active run", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const result = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});

describe("re-run keeping existing appointments (D10)", () => {
  let withdrawnBuyerId: string;
  let rerunId: string;
  let before: { slot: number; buyerId: string; supplierId: string }[];

  it("pins every row not involving the withdrawn buyer and records the parent", async () => {
    const activeRows = await db.select().from(appointments).where(eq(appointments.runId, secondRunId));
    withdrawnBuyerId = activeRows[0].buyerId;
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, withdrawnBuyerId));
    before = activeRows.map((r) => ({ slot: r.slot, buyerId: r.buyerId, supplierId: r.supplierId }));

    const result = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    rerunId = result.data.runId;
    const kept = before.filter((r) => r.buyerId !== withdrawnBuyerId);
    expect(result.data.pinnedCount).toBe(kept.length);
    expect(result.data.isActive).toBe(false);

    const run = await getRun(rerunId, db);
    expect(run?.parentRunId).toBe(secondRunId);

    const after = await db.select().from(appointments).where(eq(appointments.runId, rerunId));
    const afterKeys = new Set(after.map(key));
    for (const row of kept) expect(afterKeys.has(key(row))).toBe(true);
    expect(after.filter((r) => r.buyerId === withdrawnBuyerId)).toHaveLength(0);
    const pinnedRows = after.filter((r) => r.pinned);
    expect(pinnedRows).toHaveLength(kept.length);
    expect(after.filter((r) => !r.pinned).every((r) => r.source === "engine")).toBe(true);
    for (const warning of run?.warnings ?? []) expect(warning).not.toMatch(UUID_RE);
  });

  it("compareRuns reports what changed against the parent", async () => {
    const result = await compareRuns(db, { runId: rerunId, otherRunId: secondRunId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const removedKeys = new Set(result.data.removed.map(key));
    const withdrawnRows = before.filter((r) => r.buyerId === withdrawnBuyerId);
    expect(withdrawnRows.length).toBeGreaterThan(0);
    for (const row of withdrawnRows) expect(removedKeys.has(key(row))).toBe(true);
    expect(result.data.removed.every((r) => r.buyerName !== "" && r.supplierName !== "")).toBe(true);

    const change = result.data.countChanges.find((c) => c.personId === withdrawnBuyerId);
    expect(change?.type).toBe("buyer");
    expect(change?.before).toBe(withdrawnRows.length);
    expect(change?.after).toBe(0);
    for (const added of result.data.added) expect(added.buyerId).not.toBe(withdrawnBuyerId);
  });

  it("refuses runs from different events", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const otherRun = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!otherRun.ok) throw new Error("seed run failed");
    const result = await compareRuns(db, { runId: rerunId, otherRunId: otherRun.data.runId });
    expect(result.ok).toBe(false);
  });
});

describe("setPinned", () => {
  it("toggles the flag and bumps the run version", async () => {
    const active = await getActiveRun(seeded.eventId, db);
    if (!active) throw new Error("no active run");
    const [row] = await db.select().from(appointments).where(eq(appointments.runId, active.id)).limit(1);
    const result = await setPinned(db, { appointmentId: row.id, pinned: true, adminId: seeded.adminId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.version).toBe(active.version + 1);
    const [updated] = await db.select().from(appointments).where(eq(appointments.id, row.id));
    expect(updated.pinned).toBe(true);
    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "appointment.pin" } }, db);
    expect(audit.rows[0].entityId).toBe(row.id);

    const again = await setPinned(db, { appointmentId: row.id, pinned: true, adminId: seeded.adminId });
    expect(again.ok && again.data.version).toBe(active.version + 1);
  });

  it("refuses a stale client version", async () => {
    const active = await getActiveRun(seeded.eventId, db);
    if (!active) throw new Error("no active run");
    const [row] = await db.select().from(appointments).where(eq(appointments.runId, active.id)).limit(1);
    const result = await setPinned(db, {
      appointmentId: row.id,
      pinned: !row.pinned,
      adminId: seeded.adminId,
      version: active.version - 1,
    });
    expect(!result.ok && result.error).toMatchObject({ code: "conflict", message: VERSION_CONFLICT_MESSAGE });
  });

  it("is a conflict, not an overwrite, when another save lands between its read and its write", async () => {
    const active = await getActiveRun(seeded.eventId, db);
    if (!active) throw new Error("no active run");
    const [row] = await db.select().from(appointments).where(eq(appointments.runId, active.id)).limit(1);
    // Another admin's save commits right before this transaction starts.
    const racing = Object.create(db) as Db;
    racing.transaction = (async (fn: Parameters<Db["transaction"]>[0]) => {
      await db.update(matchRuns).set({ version: sql`${matchRuns.version} + 1` }).where(eq(matchRuns.id, active.id));
      return db.transaction(fn);
    }) as Db["transaction"];

    const result = await setPinned(racing, { appointmentId: row.id, pinned: !row.pinned, adminId: seeded.adminId });
    expect(!result.ok && result.error).toMatchObject({ code: "conflict", message: VERSION_CONFLICT_MESSAGE });
    const [unchanged] = await db.select().from(appointments).where(eq(appointments.id, row.id));
    expect(unchanged.pinned).toBe(row.pinned);
    const after = await getActiveRun(seeded.eventId, db);
    expect(after?.version).toBe(active.version + 1);
  });
});

describe("locked events", () => {
  it("refuse to run, activate, or pin", async () => {
    await db.update(events).set({ status: "locked" }).where(eq(events.id, seeded.eventId));
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    expect(!run.ok && run.error.code).toBe("locked");
    const activate = await activateRun(db, { runId: firstRunId, adminId: seeded.adminId });
    expect(!activate.ok && activate.error.code).toBe("locked");
    const [row] = await db
      .select()
      .from(appointments)
      .innerJoin(matchRuns, and(eq(matchRuns.id, appointments.runId), eq(matchRuns.isActive, true)))
      .where(eq(appointments.eventId, seeded.eventId))
      .limit(1);
    const pin = await setPinned(db, { appointmentId: row.appointments.id, pinned: false, adminId: seeded.adminId });
    expect(!pin.ok && pin.error.code).toBe("locked");
    await db.update(events).set({ status: "matched" }).where(eq(events.id, seeded.eventId));
  });
});

describe("nameWarning", () => {
  it("replaces ids with display names", () => {
    const id = "5f1c3a1e-2b7d-4c2f-9e1a-0b8d7c6e5f4a";
    const names = new Map([[id, "Hyatt Regency Monterey"]]);
    expect(nameWarning(`Supplier ${id} filled only 8 of 9`, names)).toBe(
      "Supplier Hyatt Regency Monterey filled only 8 of 9",
    );
    expect(nameWarning("Supplier unknown filled only 8 of 9", names)).toBe("Supplier unknown filled only 8 of 9");
  });
});
