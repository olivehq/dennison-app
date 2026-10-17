import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { appointments, events, matchRuns, participants, rankings } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { EVENT_CHANGED_MESSAGE } from "@/server/events/editable";
import { raceBeforeTransaction, recordQueries } from "@/server/events/test-race";
import { VERSION_CONFLICT_MESSAGE } from "@/lib/schemas/schedule";
import { listAudit } from "@/server/audit/audit";
import { displayNameFor } from "@/server/roster/display-name";
import { removeAppointment, replaceAppointment, swapCandidates } from "@/server/schedule/edits";
import { isUniqueViolation, nameWarning } from "./common";
import { loadRoster, toEngineBuyers, toEngineSuppliers } from "./input";
import { activationPreviews, compareRunForPage, getActiveRun, getRun, listRuns } from "./queries";
import {
  ACTIVATE_STALE_MESSAGE,
  activateRun,
  compareRuns,
  diffAppointments,
  failRunsOlderThan,
  RUN_ERROR_MESSAGE,
  RUN_TIMEOUT_MINUTES,
  setPinned,
  startRun,
  timedOutMessage,
} from "./runs";
import { seedEvent, UUID_RE, type Seeded } from "./test-seed";
import { computeStats, runMatching } from "@/engine";

vi.mock("@/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine")>();
  return { ...actual, runMatching: vi.fn(actual.runMatching) };
});

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

  it("keeps every row not involving the withdrawn buyer, with its own pinned flag, and records the parent", async () => {
    const activeRows = await db.select().from(appointments).where(eq(appointments.runId, secondRunId));
    withdrawnBuyerId = activeRows[0].buyerId;
    const pinnedRow = activeRows.find((r) => r.buyerId !== withdrawnBuyerId)!;
    await db.update(appointments).set({ pinned: true }).where(eq(appointments.id, pinnedRow.id));
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, withdrawnBuyerId));
    before = activeRows.map((r) => ({ slot: r.slot, buyerId: r.buyerId, supplierId: r.supplierId }));

    const result = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: true });
    // Later tests pin rows of the active run themselves.
    await db.update(appointments).set({ pinned: false }).where(eq(appointments.id, pinnedRow.id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    rerunId = result.data.runId;
    const kept = before.filter((r) => r.buyerId !== withdrawnBuyerId);
    expect(result.data.keptCount).toBe(kept.length);
    expect(result.data.isActive).toBe(false);

    const run = await getRun(rerunId, db);
    expect(run?.parentRunId).toBe(secondRunId);

    const after = await db.select().from(appointments).where(eq(appointments.runId, rerunId));
    const afterKeys = new Set(after.map(key));
    for (const row of kept) expect(afterKeys.has(key(row))).toBe(true);
    expect(after.filter((r) => r.buyerId === withdrawnBuyerId)).toHaveLength(0);
    // Only the row that was pinned stays pinned; the rest are kept but unpinned.
    expect(after.filter((r) => r.pinned).map(key)).toEqual([key(pinnedRow)]);
    const keptKeys = new Set(kept.map(key));
    expect(after.filter((r) => !keptKeys.has(key(r))).every((r) => r.source === "engine" && !r.pinned)).toBe(true);
    for (const warning of run?.warnings ?? []) expect(warning).not.toMatch(UUID_RE);

    const audit = await listAudit({ eventId: seeded.eventId, filters: { action: "matching.run", entityId: rerunId } }, db);
    expect(audit.rows[0].after).toMatchObject({ keepExisting: true, keptCount: kept.length, keptPinnedCount: 1, parentRunId: secondRunId });
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

  it("restamps the stats with the roster at the pin", async () => {
    const fresh = await seedEvent(db);
    const started = await startRun(db, { eventId: fresh.eventId, adminId: fresh.adminId, keepExisting: false });
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.data.runId;
    expect(started.data.stats.totalBuyers).toBe(12);
    const [row] = await db.select().from(appointments).where(eq(appointments.runId, runId)).limit(1);
    // Withdraw a buyer with a meeting: the stored stats still count them until the next save.
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, row.buyerId));

    const result = await setPinned(db, { appointmentId: row.id, pinned: true, adminId: fresh.adminId });
    expect(result.ok).toBe(true);

    const roster = await loadRoster(db, fresh.eventId);
    if (!roster) throw new Error("no roster");
    const rows = await db.select().from(appointments).where(eq(appointments.runId, runId));
    const [run] = await db.select().from(matchRuns).where(eq(matchRuns.id, runId));
    expect(run.stats).toEqual(
      computeStats(rows, {
        settings: roster.event.settings,
        buyers: toEngineBuyers(roster.participants),
        suppliers: toEngineSuppliers(roster.suppliers),
      }),
    );
    expect(run.stats?.totalBuyers).toBe(11);
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

describe("one active run per event", () => {
  it("the partial unique index rejects a second active run", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const first = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    const second = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!first.ok || !second.ok) throw new Error("runs failed");
    const error = await db
      .update(matchRuns)
      .set({ isActive: true })
      .where(eq(matchRuns.id, second.data.runId))
      .then(() => null, (e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
  });

  it("a first run that loses the race to another first run is stored completed and inactive", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    // Another admin's first run completes and activates while this one is matching.
    const winner = async () => {
      const [row] = await db
        .insert(matchRuns)
        .values({
          eventId: other.eventId,
          status: "completed",
          settingsSnapshot: (await db.select().from(events).where(eq(events.id, other.eventId)))[0].settings,
          isActive: true,
          createdBy: other.adminId,
          completedAt: new Date(),
        })
        .returning();
      return row;
    };
    const result = await startRun(raceBeforeTransaction(db, winner, 2), {
      eventId: other.eventId,
      adminId: other.adminId,
      keepExisting: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isActive).toBe(false);
    const runs = await listRuns(other.eventId, db);
    expect(runs.filter((r) => r.isActive)).toHaveLength(1);
    expect(runs.find((r) => r.id === result.data.runId)?.status).toBe("completed");
  });

  it("activateRun is a conflict when the event was locked between its read and its write", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const first = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    const second = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!first.ok || !second.ok) throw new Error("runs failed");
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, other.eventId));
    const result = await activateRun(raceBeforeTransaction(db, lock), { runId: second.data.runId, adminId: other.adminId });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect((await getActiveRun(other.eventId, db))?.id).toBe(first.data.runId);
  });

  it("startRun refuses with no run row when the event is locked before its setup transaction", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, other.eventId));
    const result = await startRun(raceBeforeTransaction(db, lock), { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect(await listRuns(other.eventId, db)).toHaveLength(0);
  });

  it("a first run does not activate itself when slots were removed while the engine ran", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const [event] = await db.select().from(events).where(eq(events.id, other.eventId));
    const fewer = { ...event.settings, slotCount: 1, slots: event.settings.slots.slice(0, 1), supplierTarget: 1, buyerMin: 0, buyerIdeal: 1, buyerMax: 1 };
    const shrink = () => db.update(events).set({ settings: fewer }).where(eq(events.id, other.eventId));
    const result = await startRun(raceBeforeTransaction(db, shrink, 2), { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isActive).toBe(false);
    expect((await getRun(result.data.runId, db))?.status).toBe("completed");
    expect(await getActiveRun(other.eventId, db)).toBeNull();
  });

  it("startRun marks its run failed when the event is locked while the engine runs", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, other.eventId));
    // The second transaction is the one that stores the result.
    const result = await startRun(raceBeforeTransaction(db, lock, 2), { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    const runs = await listRuns(other.eventId, db);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(await db.select().from(appointments).where(eq(appointments.eventId, other.eventId))).toHaveLength(0);
  });
});

describe("failRunsOlderThan", () => {
  it("fails runs still running after the timeout, from listRuns, and leaves fresh ones", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const [event] = await db.select().from(events).where(eq(events.id, other.eventId));
    const stale = new Date(Date.now() - 11 * 60_000);
    const [old] = await db
      .insert(matchRuns)
      .values({ eventId: other.eventId, status: "running", settingsSnapshot: event.settings, createdAt: stale })
      .returning();
    const [fresh] = await db
      .insert(matchRuns)
      .values({ eventId: other.eventId, status: "running", settingsSnapshot: event.settings })
      .returning();
    const runs = await listRuns(other.eventId, db);
    const failed = runs.find((r) => r.id === old.id);
    expect(failed?.status).toBe("failed");
    expect(runs.find((r) => r.id === fresh.id)?.status).toBe("running");
    // The Runs table gets the reason, not only a count.
    expect(failed?.warnings).toEqual([timedOutMessage(RUN_TIMEOUT_MINUTES)]);
    expect(failed?.warningCount).toBe(1);
    expect((await getRun(old.id, db))?.warnings).toEqual([timedOutMessage(RUN_TIMEOUT_MINUTES)]);
    const audit = await listAudit({ eventId: other.eventId, filters: { action: "matching.run", entityId: old.id } }, db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after).toMatchObject({ status: "failed", error: timedOutMessage(RUN_TIMEOUT_MINUTES) });
    expect(await failRunsOlderThan(db, other.eventId, 10)).toBe(0);
  });

  it("leaves other events' runs alone, and archived events unchanged", async () => {
    const a = await seedEvent(db, { buyers: 4 });
    const b = await seedEvent(db, { buyers: 4 });
    const archived = await seedEvent(db, { buyers: 4, status: "archived" });
    const [event] = await db.select().from(events).where(eq(events.id, b.eventId));
    const stale = new Date(Date.now() - 11 * 60_000);
    const stuck = async (eventId: string) =>
      (
        await db
          .insert(matchRuns)
          .values({ eventId, status: "running", settingsSnapshot: event.settings, createdAt: stale })
          .returning()
      )[0];
    const onB = await stuck(b.eventId);
    const onArchived = await stuck(archived.eventId);

    await listRuns(a.eventId, db);
    expect((await getRun(onB.id, db))?.status).toBe("running");

    expect((await listRuns(archived.eventId, db))[0].status).toBe("running");
    expect(await failRunsOlderThan(db, archived.eventId, 10)).toBe(0);
    expect((await getRun(onArchived.id, db))?.status).toBe("running");

    expect((await listRuns(b.eventId, db))[0].status).toBe("failed");
  });

  it("changes nothing when the event is archived between its check and its transaction", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const [event] = await db.select().from(events).where(eq(events.id, other.eventId));
    const [stuck] = await db
      .insert(matchRuns)
      .values({ eventId: other.eventId, status: "running", settingsSnapshot: event.settings, createdAt: new Date(Date.now() - 11 * 60_000) })
      .returning();
    const archive = () => db.update(events).set({ status: "archived" }).where(eq(events.id, other.eventId));
    expect(await failRunsOlderThan(raceBeforeTransaction(db, archive), other.eventId, 10)).toBe(0);
    expect((await getRun(stuck.id, db))?.status).toBe("running");
    expect((await listAudit({ eventId: other.eventId, filters: { action: "matching.run" } }, db)).total).toBe(0);
  });

  it("locks the event row before the runs, and takes no lock when nothing is stuck", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const recorded = recordQueries(db);
    expect(await failRunsOlderThan(recorded.db, other.eventId, 10)).toBe(0);
    expect(recorded.queries.some((q) => q.includes("for update"))).toBe(false);

    const [event] = await db.select().from(events).where(eq(events.id, other.eventId));
    await db
      .insert(matchRuns)
      .values({ eventId: other.eventId, status: "running", settingsSnapshot: event.settings, createdAt: new Date(Date.now() - 11 * 60_000) });
    recorded.queries.length = 0;
    expect(await failRunsOlderThan(recorded.db, other.eventId, 10)).toBe(1);
    const claim = recorded.queries.findIndex((q) => /from "events" .*for update/.test(q));
    const update = recorded.queries.findIndex((q) => q.startsWith('update "match_runs"'));
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(update);
  });

  it("stores a fixed reason for an unexpected error and logs the error itself", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    vi.mocked(runMatching).mockImplementationOnce(() => {
      throw new Error("relation \"x\" does not exist at engine/internal.ts:42");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.objectContaining({ message: expect.stringContaining("engine/internal.ts") }));
    error.mockRestore();
    expect(!result.ok && result.error.code).toBe("internal");
    const [run] = await listRuns(other.eventId, db);
    expect(run.status).toBe("failed");
    expect(run.warnings).toEqual([RUN_ERROR_MESSAGE]);
    const audit = await listAudit({ eventId: other.eventId, filters: { action: "matching.run", entityId: run.id } }, db);
    expect(audit.rows[0].after).toMatchObject({ status: "failed", error: RUN_ERROR_MESSAGE });
  });

  it("listRuns gives a failed run's error as its warnings", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, other.eventId));
    await startRun(raceBeforeTransaction(db, lock, 2), { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    const [run] = await listRuns(other.eventId, db);
    expect(run.status).toBe("failed");
    expect(run.warnings).toEqual(["The event was locked or archived while matching ran."]);
  });
});

describe("activateRun with the version the page read (D11)", () => {
  it("is a conflict when the active run was edited or another run activated after the page read it", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const first = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    const second = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!first.ok || !second.ok) throw new Error("runs failed");
    const read = (await listRuns(other.eventId, db)).find((r) => r.isActive)!;
    const expected = { activeRunId: read.id, version: read.version };

    // Someone edits the active run between the page read and the click.
    const [row] = await db.select().from(appointments).where(eq(appointments.runId, first.data.runId)).limit(1);
    const removed = await removeAppointment(
      db,
      { runId: first.data.runId, version: read.version, slot: row.slot, supplierId: row.supplierId, buyerId: row.buyerId },
      other.adminId,
    );
    expect(removed.ok).toBe(true);
    const stale = await activateRun(db, { runId: second.data.runId, adminId: other.adminId, expected });
    expect(stale).toEqual({ ok: false, error: { code: "conflict", message: ACTIVATE_STALE_MESSAGE } });
    expect((await getActiveRun(other.eventId, db))?.id).toBe(first.data.runId);
    expect((await listAudit({ eventId: other.eventId, filters: { action: "matching.activate" } }, db)).total).toBe(0);

    // With the version read again it goes through.
    const fresh = await getActiveRun(other.eventId, db);
    const activated = await activateRun(db, {
      runId: second.data.runId,
      adminId: other.adminId,
      expected: { activeRunId: fresh!.id, version: fresh!.version },
    });
    expect(activated.ok).toBe(true);

    // The page still thinks the first run is active; activating it from that read is a conflict too.
    const third = await activateRun(db, { runId: first.data.runId, adminId: other.adminId, expected });
    expect(third).toEqual({ ok: false, error: { code: "conflict", message: ACTIVATE_STALE_MESSAGE } });
  });

  it("activationPreviews returns the active run and version its counts came from", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const first = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    const second = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!first.ok || !second.ok) throw new Error("runs failed");
    expect((await activationPreviews(other.eventId, db)).active).toEqual({ id: first.data.runId, version: 1 });

    const [row] = await db.select().from(appointments).where(eq(appointments.runId, first.data.runId)).limit(1);
    const removed = await removeAppointment(
      db,
      { runId: first.data.runId, version: 1, slot: row.slot, supplierId: row.supplierId, buyerId: row.buyerId },
      other.adminId,
    );
    expect(removed.ok).toBe(true);
    const previews = await activationPreviews(other.eventId, db);
    expect(previews.active).toEqual({ id: first.data.runId, version: 2 });
    // What the button sends with those counts goes through.
    const activated = await activateRun(db, {
      runId: second.data.runId,
      adminId: other.adminId,
      expected: { activeRunId: previews.active!.id, version: previews.active!.version },
    });
    expect(activated.ok).toBe(true);
  });

  it("is a conflict when the page saw no active run and one became active", async () => {
    const other = await seedEvent(db, { buyers: 4 });
    const first = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    const second = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!first.ok || !second.ok) throw new Error("runs failed");
    const result = await activateRun(db, {
      runId: second.data.runId,
      adminId: other.adminId,
      expected: { activeRunId: null, version: null },
    });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: ACTIVATE_STALE_MESSAGE } });
  });
});

describe("comparisons for the matching page", () => {
  it("compares a kept-existing run with its parent by default and can switch to the active run", async () => {
    const other = await seedEvent(db);
    const first = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    const second = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: false });
    if (!first.ok || !second.ok) throw new Error("runs failed");
    // Activate the second, re-run keeping it, then go back to the first: the re-run's parent is not the active run.
    await activateRun(db, { runId: second.data.runId, adminId: other.adminId });
    const rerun = await startRun(db, { eventId: other.eventId, adminId: other.adminId, keepExisting: true });
    if (!rerun.ok) throw new Error("rerun failed");
    await activateRun(db, { runId: first.data.runId, adminId: other.adminId });

    const byDefault = await compareRunForPage(other.eventId, rerun.data.runId, undefined, db);
    expect(byDefault?.against).toBe("parent");
    expect(byDefault?.otherRunId).toBe(second.data.runId);
    expect(byDefault?.options).toEqual(["parent", "active"]);
    expect(byDefault?.result.ok && byDefault.result.data.removed).toEqual([]);

    const vsActive = await compareRunForPage(other.eventId, rerun.data.runId, "active", db);
    expect(vsActive?.otherRunId).toBe(first.data.runId);

    // A run with no parent compares with the active run; the active run has nothing to compare with.
    expect((await compareRunForPage(other.eventId, second.data.runId, undefined, db))?.against).toBe("active");
    expect(await compareRunForPage(other.eventId, first.data.runId, undefined, db)).toBeNull();

    const previews = await activationPreviews(other.eventId, db);
    expect([...previews.byRun.keys()].sort()).toEqual([second.data.runId, rerun.data.runId].sort());
    const full = await compareRuns(db, { runId: second.data.runId, otherRunId: first.data.runId });
    if (!full.ok) throw new Error("compare failed");
    expect(previews.byRun.get(second.data.runId)).toEqual({
      added: full.data.added.length,
      removed: full.data.removed.length,
      countChanges: full.data.countChanges.length,
    });
  });
});

describe("diffAppointments", () => {
  it("sorts the count changes by name with compareNames, buyers and suppliers together", () => {
    const row = (id: string, slot: number, buyerId: string, supplierId: string) => ({
      id,
      slot,
      buyerId,
      supplierId,
      buyerRank: null,
      supplierRank: null,
      source: "engine" as const,
      pinned: false,
    });
    const names = new Map([
      ["b1", "hall 10 buyer"],
      ["b2", "Hall 2 buyer"],
      ["s1", "Zeta Hotel"],
      ["s2", "Álvarez Audio"],
    ]);
    const diff = diffAppointments([row("n1", 1, "b1", "s1"), row("n2", 2, "b2", "s2")], [], names, new Set(["s1", "s2"]));
    expect(diff.countChanges.map((c) => [c.name, c.type])).toEqual([
      ["Álvarez Audio", "supplier"],
      ["Hall 2 buyer", "buyer"],
      ["hall 10 buyer", "buyer"],
      ["Zeta Hotel", "supplier"],
    ]);
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

describe("pinned rows carried into a new run", () => {
  async function activeRows(eventId: string) {
    const active = await getActiveRun(eventId, db);
    return db.select().from(appointments).where(eq(appointments.runId, active!.id));
  }

  it("keep existing re-stamps ranks from the current rankings", async () => {
    const event = await seedEvent(db);
    const first = await startRun(db, { eventId: event.eventId, adminId: event.adminId, keepExisting: false });
    if (!first.ok) throw new Error(first.error.message);
    const [row] = await activeRows(event.eventId);
    // The buyer's file was re-imported with this supplier at 42.
    await db
      .insert(rankings)
      .values({ eventId: event.eventId, rankerType: "buyer", rankerId: row.buyerId, targetType: "supplier", targetId: row.supplierId, rank: 42, isRejection: false })
      .onConflictDoUpdate({
        target: [rankings.eventId, rankings.rankerType, rankings.rankerId, rankings.targetType, rankings.targetId],
        set: { rank: 42, isRejection: false },
      });
    const rerun = await startRun(db, { eventId: event.eventId, adminId: event.adminId, keepExisting: true });
    if (!rerun.ok) throw new Error(rerun.error.message);
    const [kept] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.runId, rerun.data.runId), eq(appointments.buyerId, row.buyerId), eq(appointments.supplierId, row.supplierId)));
    expect(kept).toMatchObject({ slot: row.slot, pinned: false, buyerRank: 42 });
  });

  it("an ordinary run starts from scratch: no pins, no kept rows, no parent", async () => {
    const event = await seedEvent(db);
    const first = await startRun(db, { eventId: event.eventId, adminId: event.adminId, keepExisting: false });
    if (!first.ok) throw new Error(first.error.message);
    const rows = await activeRows(event.eventId);
    // Every row of the active run pinned, one of them a manual edit.
    await db.update(appointments).set({ pinned: true }).where(eq(appointments.runId, first.data.runId));
    await db.update(appointments).set({ source: "manual" }).where(eq(appointments.id, rows[0].id));
    const rerun = await startRun(db, { eventId: event.eventId, adminId: event.adminId, keepExisting: false });
    if (!rerun.ok) throw new Error(rerun.error.message);
    expect(rerun.data.keptCount).toBe(0);
    const stored = await db.select().from(appointments).where(eq(appointments.runId, rerun.data.runId));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((r) => !r.pinned && r.source === "engine")).toBe(true);
    expect((await getRun(rerun.data.runId, db))?.parentRunId ?? null).toBeNull();
    // Same rankings and settings, deterministic engine: the same schedule the first run got.
    expect(stored.map(key).sort()).toEqual(rows.map(key).sort());
  });

  it("drops kept rows whose pair became ineligible, with named warnings, and counts only what it kept", async () => {
    const event = await seedEvent(db);
    const first = await startRun(db, { eventId: event.eventId, adminId: event.adminId, keepExisting: false });
    if (!first.ok) throw new Error(first.error.message);
    const rows = await activeRows(event.eventId);
    const supplierById = new Map(event.suppliers.map((s) => [s.id, s]));
    const buyerById = new Map(event.buyers.map((b) => [b.id, b]));
    const business = rows.filter((r) => supplierById.get(r.supplierId)!.type === "business");
    const rejected = rows.find((r) => supplierById.get(r.supplierId)!.type === "hotel")!;
    const optedOut = business.find((r) => r.buyerId !== rejected.buyerId)!;
    // A re-import: one buyer now marks the hotel N/A, another opts out of biztech.
    await db
      .update(rankings)
      .set({ rank: null, isRejection: true })
      .where(and(eq(rankings.eventId, event.eventId), eq(rankings.rankerId, rejected.buyerId), eq(rankings.targetId, rejected.supplierId)));
    await db
      .insert(rankings)
      .values({ eventId: event.eventId, rankerType: "buyer", rankerId: rejected.buyerId, targetType: "supplier", targetId: rejected.supplierId, rank: null, isRejection: true })
      .onConflictDoNothing();
    await db.update(participants).set({ biztechOptIn: false }).where(eq(participants.id, optedOut.buyerId));
    // The N/A row was pinned; the opted-out row was kept but not pinned.
    await db.update(appointments).set({ pinned: true }).where(eq(appointments.id, rejected.id));

    const rerun = await startRun(db, { eventId: event.eventId, adminId: event.adminId, keepExisting: true });
    if (!rerun.ok) throw new Error(rerun.error.message);
    const name = (id: string) => displayNameFor(buyerById.get(id)!);
    const supplierName = (id: string) => supplierById.get(id)!.name;
    expect(rerun.data.warnings).toContain(
      `Dropped pinned appointment slot ${rejected.slot} ${name(rejected.buyerId)} x ${supplierName(rejected.supplierId)}: ${name(rejected.buyerId)} marked ${supplierName(rejected.supplierId)} as N/A`,
    );
    expect(rerun.data.warnings).toContain(
      `Dropped kept appointment slot ${optedOut.slot} ${name(optedOut.buyerId)} x ${supplierName(optedOut.supplierId)}: ${name(optedOut.buyerId)} is not opted in to business meetings`,
    );
    const stored = await db.select().from(appointments).where(eq(appointments.runId, rerun.data.runId));
    const has = (r: { buyerId: string; supplierId: string }) => stored.some((s) => s.buyerId === r.buyerId && s.supplierId === r.supplierId);
    expect(has(rejected)).toBe(false);
    expect(has(optedOut)).toBe(false);
    const dropped = rows.filter(
      (r) => r.id === rejected.id || (r.buyerId === optedOut.buyerId && supplierById.get(r.supplierId)!.type === "business"),
    );
    expect(rerun.data.keptCount).toBe(rows.length - dropped.length);
  });
});

describe("reactivating an earlier run (client report, Oct 16)", () => {
  type Row = typeof appointments.$inferSelect;
  const rowsOf = (runId: string) => db.select().from(appointments).where(eq(appointments.runId, runId));
  const shape = (rows: Row[]) =>
    rows.map((r) => ({ slot: r.slot, buyerId: r.buyerId, supplierId: r.supplierId, pinned: r.pinned })).sort((a, b) => key(a).localeCompare(key(b)));
  const versionOf = async (runId: string) => (await getRun(runId, db))!.version;

  it("brings back exactly that run's appointments and pins, with nothing from later runs", async () => {
    const event = await seedEvent(db);
    const admin = event.adminId;

    // 1. Run matching; the first run becomes active.
    const first = await startRun(db, { eventId: event.eventId, adminId: admin, keepExisting: false });
    if (!first.ok) throw new Error(first.error.message);
    const run1 = first.data.runId;

    // 2. One removal on the active schedule, not pinned.
    const [gone] = await rowsOf(run1);
    const removed = await removeAppointment(
      db,
      { runId: run1, version: await versionOf(run1), slot: gone.slot, supplierId: gone.supplierId, buyerId: gone.buyerId },
      admin,
    );
    if (!removed.ok) throw new Error(removed.error.message);
    const run1Snapshot = shape(await rowsOf(run1));

    // 3. Re-run keeping existing appointments, then activate it.
    const second = await startRun(db, { eventId: event.eventId, adminId: admin, keepExisting: true });
    if (!second.ok) throw new Error(second.error.message);
    const run2 = second.data.runId;
    expect((await activateRun(db, { runId: run2, adminId: admin })).ok).toBe(true);

    // 4. On that schedule, replace one appointment and pin the replacement.
    let replaced: Row | null = null;
    for (const target of await rowsOf(run2)) {
      const candidates = await swapCandidates(db, { runId: run2, supplierId: target.supplierId, slot: target.slot, excludeBuyerId: target.buyerId });
      if (!candidates.ok || candidates.data.length === 0) continue;
      const result = await replaceAppointment(
        db,
        {
          runId: run2,
          version: await versionOf(run2),
          slot: target.slot,
          supplierId: target.supplierId,
          removeBuyerId: target.buyerId,
          addBuyerId: candidates.data[0].buyerId,
        },
        admin,
      );
      if (!result.ok) throw new Error(result.error.message);
      [replaced] = await db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.runId, run2),
            eq(appointments.slot, target.slot),
            eq(appointments.supplierId, target.supplierId),
            eq(appointments.buyerId, candidates.data[0].buyerId),
          ),
        );
      break;
    }
    if (!replaced) throw new Error("no appointment in the fixture has a swap candidate");
    const pinned = await setPinned(db, { appointmentId: replaced.id, pinned: true, adminId: admin });
    if (!pinned.ok) throw new Error(pinned.error.message);

    // 5. Re-run keeping existing again, then activate it.
    const third = await startRun(db, { eventId: event.eventId, adminId: admin, keepExisting: true });
    if (!third.ok) throw new Error(third.error.message);
    const run3 = third.data.runId;
    expect((await activateRun(db, { runId: run3, adminId: admin })).ok).toBe(true);
    const run3Rows = await rowsOf(run3);
    expect(run3Rows.filter((r) => r.pinned).map(key)).toEqual([key(replaced)]);

    // 6. Activate the first run: its own rows and flags, no pin from run 2 or 3.
    expect((await activateRun(db, { runId: run1, adminId: admin })).ok).toBe(true);
    expect((await getActiveRun(event.eventId, db))?.id).toBe(run1);
    const restored = await rowsOf(run1);
    expect(shape(restored)).toEqual(run1Snapshot);
    expect(restored.some((r) => r.pinned)).toBe(false);
  });
});
