import { and, eq, lt, max, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, events, matchRuns, type MatchRun } from "@/db/schema";
import { buildRankingIndex, computeStats, runMatching, type Appointment, type QualityStats } from "@/engine";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { compareNames } from "@/lib/names";
import { NOT_ACTIVE_RUN_MESSAGE, VERSION_CONFLICT_MESSAGE } from "@/lib/schemas/schedule";
import { recordAudit } from "@/server/audit/audit";
import {
  assertEventEditable,
  claimEditableEvent,
  claimUnarchivedEvent,
  EVENT_CHANGED_MESSAGE,
  EventChangedError,
} from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { cachePerRender } from "@/server/render-cache";
import { advanceStatus } from "@/server/events/status";
import { isUniqueViolation, nameWarning } from "./common";
import {
  buildMatchInput,
  loadRoster,
  toEngineBuyers,
  toEngineRankings,
  toEngineSuppliers,
  type Roster,
} from "./input";
import { matchingReadiness } from "./readiness";

export type StartRunInput = {
  eventId: string;
  adminId: string;
  /**
   * D10: keep every appointment of the active run that involves no withdrawn
   * person, each with its own pinned flag, and fill the open slots. Without it
   * the run starts from scratch: no kept rows, no pins, no parent.
   */
  keepExisting: boolean;
};

export type StartRunResult = {
  runId: string;
  isActive: boolean;
  stats: QualityStats;
  warnings: string[];
  durationMs: number;
  /** Appointments of the active run the new run kept (after the engine dropped any). 0 for a run from scratch. */
  keptCount: number;
};

export type AppointmentView = {
  id: string;
  slot: number;
  buyerId: string;
  buyerName: string;
  supplierId: string;
  supplierName: string;
  buyerRank: number | null;
  supplierRank: number | null;
  source: "engine" | "manual";
  pinned: boolean;
};

export type CountChange = {
  personId: string;
  name: string;
  type: "buyer" | "supplier";
  before: number;
  after: number;
};

export type RunComparison = {
  added: AppointmentView[];
  removed: AppointmentView[];
  countChanges: CountChange[];
};

export async function findRun(db: Db, runId: string): Promise<MatchRun | null> {
  const [run] = await db.select().from(matchRuns).where(eq(matchRuns.id, runId)).limit(1);
  return run ?? null;
}

/** The event's active run, or null. Shared per render on the default client; a transaction reads fresh. */
export const findActiveRun = cachePerRender(async (db: Db, eventId: string): Promise<MatchRun | null> => {
  const [run] = await db
    .select()
    .from(matchRuns)
    .where(and(eq(matchRuns.eventId, eventId), eq(matchRuns.isActive, true)))
    .limit(1);
  return run ?? null;
});

/** The highest slot a run's appointments use, or null when it has none. */
async function highestSlotOfRun(db: Db, runId: string): Promise<number | null> {
  const [row] = await db.select({ value: max(appointments.slot) }).from(appointments).where(eq(appointments.runId, runId));
  return row?.value ?? null;
}

/** The event's slot count as stored now. */
async function currentSlotCount(db: Db, eventId: string): Promise<number> {
  const [row] = await db.select({ settings: events.settings }).from(events).where(eq(events.id, eventId));
  return row.settings.slotCount;
}

/** An event with an active run has been matched. Only `imported` moves; later statuses stay (compare-and-set). */
async function markMatched(tx: Db, eventId: string): Promise<void> {
  await advanceStatus(tx, eventId, "imported", "matched");
}

/** Returned when a second run tried to become active at the same moment as another (unique index on the active run). */
export const ACTIVATE_CONFLICT_MESSAGE =
  "Another admin activated a different run at the same moment. Reload to see which run is active.";

/** A run still `running` this long after it started died with its request (D13 timeout is 10 minutes too). */
export const RUN_TIMEOUT_MINUTES = 10;

/** What a timed-out run shows in the Runs table and the activity log. */
export function timedOutMessage(minutes: number): string {
  return `Matching didn't finish within ${minutes} minutes, so this run was marked failed. Run matching again.`;
}

/** What a run that stopped on an unexpected error shows. The error itself goes to the server log only. */
export const RUN_ERROR_MESSAGE = "Matching stopped with an error. Run matching again; if it fails again, contact support.";

/**
 * Marks the event's runs that are still `running` after `minutes` as failed,
 * with a reason in `warnings` and a failed `matching.run` audit row each. The
 * running row is inserted before the engine starts so the page can show it; a
 * crash or a killed function leaves it behind. Other events' runs are left
 * alone, and an archived event is not changed at all.
 *
 * Runs on every matching page load, so it first checks for a stuck run
 * without a lock. Only when there is one does it open a transaction that
 * claims the event row while unarchived (`claimUnarchivedEvent`, the event
 * row before the run rows, as `startRun` does), so an archive waits for it
 * or goes first and makes it change nothing.
 */
export async function failRunsOlderThan(
  db: Db,
  eventId: string,
  minutes: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const stuck = and(eq(matchRuns.eventId, eventId), eq(matchRuns.status, "running"), lt(matchRuns.createdAt, cutoff));
  const [any] = await db.select({ id: matchRuns.id }).from(matchRuns).where(stuck).limit(1);
  if (!any) return 0;
  const message = timedOutMessage(minutes);
  return db.transaction(async (tx) => {
    if (!(await claimUnarchivedEvent(tx, eventId))) return 0;
    const rows = await tx
      .update(matchRuns)
      .set({ status: "failed", warnings: [message], completedAt: now })
      .where(stuck)
      .returning({ id: matchRuns.id, createdBy: matchRuns.createdBy, parentRunId: matchRuns.parentRunId });
    for (const row of rows) {
      await recordAudit(tx, {
        eventId,
        adminId: row.createdBy,
        action: "matching.run",
        entityType: "match_run",
        entityId: row.id,
        after: { status: "failed", keepExisting: row.parentRunId !== null, parentRunId: row.parentRunId, error: message },
      });
    }
    return rows.length;
  });
}

/**
 * Appointments of the active run that "keep existing" (D10) carries into the
 * new run: every row except those naming a withdrawn buyer or supplier, so
 * their slots can be refilled. Each row keeps its own pinned flag. Ranks are
 * stamped again from the current rankings, so a re-import since the run shows
 * in the kept rows and the stats; the engine drops pairs that are no longer
 * eligible.
 */
async function loadKeptFromActiveRun(db: Db, roster: Roster, activeRunId: string): Promise<Appointment[]> {
  const withdrawn = new Set<string>([
    ...roster.participants.filter((p) => p.status === "withdrawn").map((p) => p.id),
    ...roster.suppliers.filter((s) => s.status === "withdrawn").map((s) => s.id),
  ]);
  const index = buildRankingIndex(toEngineRankings(roster.rankings));
  const rows = await db.select().from(appointments).where(eq(appointments.runId, activeRunId));
  return rows
    .filter((r) => !withdrawn.has(r.buyerId) && !withdrawn.has(r.supplierId))
    .map((r) => ({
      slot: r.slot,
      buyerId: r.buyerId,
      supplierId: r.supplierId,
      buyerRank: index.buyerRank(r.buyerId, r.supplierId),
      supplierRank: index.supplierRank(r.supplierId, r.buyerId),
      source: r.source,
      pinned: r.pinned,
    }));
}

/** Thrown inside the run's setup transaction to return `result` (nothing is written yet). */
class RunRefused extends Error {
  constructor(readonly result: ActionResult<never>) {
    super(result.ok ? "" : result.error.message);
  }
}

/**
 * Runs the engine and stores the result as a new `match_runs` row. The first
 * completed run of an event becomes active on its own; later runs wait for
 * `activateRun` so an admin can compare first (scope 2.2 re-run addition).
 *
 * The readiness gate, the roster, rankings, and kept rows, and the running
 * row are read and written in one transaction that holds the event row
 * (`claimEditableEvent`), so an import apply, which takes the same row, lands
 * wholly before or wholly after the inputs. The engine runs after it commits.
 */
export async function startRun(db: Db, input: StartRunInput): Promise<ActionResult<StartRunResult>> {
  const event = await getEvent(input.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return locked;

  let setup: { roster: Roster; kept: Appointment[]; parentRunId: string | null; run: MatchRun };
  try {
    setup = await db.transaction(async (tx) => {
      await claimEditableEvent(tx, input.eventId);
      const readiness = await matchingReadiness(tx, input.eventId);
      if (!readiness.ready) throw new RunRefused(fail("validation", readiness.reasons.join(" ")));
      const roster = (await loadRoster(tx, input.eventId))!;
      // A plain run starts from scratch and never reads the active run.
      let kept: Appointment[] = [];
      let parentRunId: string | null = null;
      if (input.keepExisting) {
        const active = await findActiveRun(tx, input.eventId);
        if (!active) {
          throw new RunRefused(
            fail("validation", "There is no active run to keep. Run matching without keeping existing appointments."),
          );
        }
        kept = await loadKeptFromActiveRun(tx, roster, active.id);
        parentRunId = active.id;
      }
      const [run] = await tx
        .insert(matchRuns)
        .values({
          eventId: input.eventId,
          status: "running",
          settingsSnapshot: roster.event.settings,
          parentRunId,
          createdBy: input.adminId,
        })
        .returning();
      return { roster, kept, parentRunId, run };
    });
  } catch (error) {
    if (error instanceof RunRefused) return error.result;
    if (error instanceof EventChangedError) return fail("conflict", EVENT_CHANGED_MESSAGE);
    throw error;
  }
  const { roster, kept, parentRunId, run } = setup;

  try {
    const started = performance.now();
    const result = runMatching(buildMatchInput(roster, kept));
    const durationMs = Math.round(performance.now() - started);
    const warnings = result.warnings.map((w) => nameWarning(w, roster.names));
    // The engine drops kept rows that are no longer valid; count what it actually kept.
    const keptKeys = new Set(kept.map(appointmentKey));
    const keptRows = result.appointments.filter((a) => keptKeys.has(appointmentKey(a)));
    const keptCount = keptRows.length;

    const isActive = await db.transaction(async (tx) => {
      // Lock or archive may have landed while the engine ran.
      await claimEditableEvent(tx, input.eventId);
      if (result.appointments.length > 0) {
        await tx.insert(appointments).values(
          result.appointments.map((a) => ({
            runId: run.id,
            eventId: input.eventId,
            slot: a.slot,
            buyerId: a.buyerId,
            supplierId: a.supplierId,
            buyerRank: a.buyerRank,
            supplierRank: a.supplierRank,
            source: a.source,
            pinned: a.pinned,
          })),
        );
      }
      await tx
        .update(matchRuns)
        .set({ status: "completed", stats: result.stats, warnings, durationMs, completedAt: new Date() })
        .where(eq(matchRuns.id, run.id));
      // The first completed run becomes active. Two first runs at once: the
      // unique index lets one win; the other stays a completed, inactive run.
      // A run that no longer fits the slot count (settings saved while it ran) never activates itself.
      const highest = Math.max(0, ...result.appointments.map((a) => a.slot));
      const fits = highest <= (await currentSlotCount(tx, input.eventId));
      const makeActive = fits && (await findActiveRun(tx, input.eventId)) === null && (await setActiveFlag(tx, run.id));
      if (makeActive) await markMatched(tx, input.eventId);
      await recordAudit(tx, {
        eventId: input.eventId,
        adminId: input.adminId,
        action: "matching.run",
        entityType: "match_run",
        entityId: run.id,
        after: {
          status: "completed",
          keepExisting: input.keepExisting,
          parentRunId,
          keptCount,
          keptPinnedCount: keptRows.filter((a) => a.pinned).length,
          appointments: result.appointments.length,
          warningCount: warnings.length,
          durationMs,
          isActive: makeActive,
        },
      });
      return makeActive;
    });

    return ok({
      runId: run.id,
      isActive,
      stats: result.stats,
      warnings,
      durationMs,
      keptCount,
    });
  } catch (error) {
    const changed = error instanceof EventChangedError;
    // The page shows a fixed sentence; the raw error may name internals, so it goes to the log.
    const message = changed ? "The event was locked or archived while matching ran." : RUN_ERROR_MESSAGE;
    if (!changed) console.error(`[matching] run ${run.id} of event ${input.eventId} failed:`, error);
    await db.transaction(async (tx) => {
      await tx
        .update(matchRuns)
        .set({ status: "failed", warnings: [message], completedAt: new Date() })
        .where(eq(matchRuns.id, run.id));
      await recordAudit(tx, {
        eventId: input.eventId,
        adminId: input.adminId,
        action: "matching.run",
        entityType: "match_run",
        entityId: run.id,
        after: { status: "failed", keepExisting: input.keepExisting, parentRunId, error: message },
      });
    });
    if (changed) return fail("conflict", EVENT_CHANGED_MESSAGE);
    return fail("internal", "Matching failed. The Runs table below shows why.");
  }
}

/**
 * Sets `is_active` on one run inside a savepoint. Returns false when the
 * partial unique index says another run of the event is already active, so
 * the caller's transaction carries on instead of aborting.
 */
async function setActiveFlag(tx: Db, runId: string): Promise<boolean> {
  try {
    await tx.transaction(async (sp) => {
      await sp.update(matchRuns).set({ isActive: true }).where(eq(matchRuns.id, runId));
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/** Returned when the active run or its version moved after the page showed what activating would change (D11). */
export const ACTIVATE_STALE_MESSAGE =
  "Someone changed or activated the schedule since this page loaded. Reload and check the counts, then activate again.";

/**
 * Makes one run the schedule everyone sees and edits. Clears the flag on every
 * other run of the event, all in one transaction that first claims the event
 * as editable. The partial unique index on the active run is the authority: a
 * concurrent activation that slips past becomes a conflict, never two actives.
 *
 * `expected` is the active run and its version as the page read them (both
 * null when no run was active). When sent, a different active run or a newer
 * version is a conflict, so the counts the confirm showed are the ones applied.
 */
export async function activateRun(
  db: Db,
  input: {
    runId: string;
    adminId: string;
    expected?: { activeRunId: string | null; version: number | null };
  },
): Promise<ActionResult<{ runId: string }>> {
  const run = await findRun(db, input.runId);
  if (!run) return fail("not_found", "That run no longer exists.");
  if (run.status !== "completed") return fail("validation", "Only a completed run can be activated.");
  const event = await getEvent(run.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return locked;
  if (run.isActive) return ok({ runId: run.id });

  try {
    await db.transaction(async (tx) => {
      await claimEditableEvent(tx, run.eventId);
      const previous = await findActiveRun(tx, run.eventId);
      if (previous?.id === run.id) return;
      const { expected } = input;
      if (expected && ((previous?.id ?? null) !== expected.activeRunId || (previous?.version ?? null) !== expected.version)) {
        throw new RunRefused(fail("conflict", ACTIVATE_STALE_MESSAGE));
      }
      // Settings may have lost slots since the run (D98 amendment): its appointments would sit in slots that no longer exist.
      const highest = await highestSlotOfRun(tx, run.id);
      const slotCount = await currentSlotCount(tx, run.eventId);
      if (highest !== null && highest > slotCount) {
        throw new RunRefused(
          fail(
            "validation",
            `This run uses slot ${highest}, but the event now has ${slotCount} slots. Run matching again with the current settings, or add the slots back in Settings.`,
          ),
        );
      }
      await tx
        .update(matchRuns)
        .set({ isActive: false })
        .where(and(eq(matchRuns.eventId, run.eventId), eq(matchRuns.isActive, true)));
      await tx.update(matchRuns).set({ isActive: true }).where(eq(matchRuns.id, run.id));
      await markMatched(tx, run.eventId);
      await recordAudit(tx, {
        eventId: run.eventId,
        adminId: input.adminId,
        action: "matching.activate",
        entityType: "match_run",
        entityId: run.id,
        before: { activeRunId: previous?.id ?? null },
        after: { activeRunId: run.id },
      });
    });
  } catch (error) {
    if (error instanceof RunRefused) return error.result;
    if (error instanceof EventChangedError) return fail("conflict", EVENT_CHANGED_MESSAGE);
    if (isUniqueViolation(error)) return fail("conflict", ACTIVATE_CONFLICT_MESSAGE);
    throw error;
  }
  return ok({ runId: run.id });
}

function appointmentKey(a: { slot: number; buyerId: string; supplierId: string }): string {
  return `${a.slot}\u0000${a.buyerId}\u0000${a.supplierId}`;
}

function compareViews(a: AppointmentView, b: AppointmentView): number {
  return a.slot - b.slot || compareNames(a.supplierName, b.supplierName) || compareNames(a.buyerName, b.buyerName);
}

/**
 * What changes if `runId` replaces `otherRunId`: appointments only in the new
 * run, appointments only in the old one, and every person whose count moves.
 */
export async function compareRuns(
  db: Db,
  input: { runId: string; otherRunId: string },
): Promise<ActionResult<RunComparison>> {
  const [run, other] = await Promise.all([findRun(db, input.runId), findRun(db, input.otherRunId)]);
  if (!run || !other) return fail("not_found", "One of those runs no longer exists.");
  if (run.eventId !== other.eventId) return fail("validation", "Those runs belong to different events.");
  const roster = await loadRoster(db, run.eventId);
  if (!roster) return fail("not_found", "That event no longer exists.");

  const [newRows, oldRows] = await Promise.all([
    db.select().from(appointments).where(eq(appointments.runId, run.id)),
    db.select().from(appointments).where(eq(appointments.runId, other.id)),
  ]);
  return ok(diffAppointments(newRows, oldRows, roster.names, new Set(roster.suppliers.map((s) => s.id))));
}

type DiffRow = Pick<
  typeof appointments.$inferSelect,
  "id" | "slot" | "buyerId" | "supplierId" | "buyerRank" | "supplierRank" | "source" | "pinned"
>;

/** What changes if `newRows` replace `oldRows`. Pure, so the page can summarise many runs from one query. */
export function diffAppointments(
  newRows: DiffRow[],
  oldRows: DiffRow[],
  names: ReadonlyMap<string, string>,
  supplierIds: ReadonlySet<string>,
): RunComparison {
  const name = (id: string) => names.get(id) ?? id;
  const toView = (r: DiffRow): AppointmentView => ({
    id: r.id,
    slot: r.slot,
    buyerId: r.buyerId,
    buyerName: name(r.buyerId),
    supplierId: r.supplierId,
    supplierName: name(r.supplierId),
    buyerRank: r.buyerRank,
    supplierRank: r.supplierRank,
    source: r.source,
    pinned: r.pinned,
  });

  const newKeys = new Set(newRows.map(appointmentKey));
  const oldKeys = new Set(oldRows.map(appointmentKey));
  const added = newRows.filter((r) => !oldKeys.has(appointmentKey(r))).map(toView).sort(compareViews);
  const removed = oldRows.filter((r) => !newKeys.has(appointmentKey(r))).map(toView).sort(compareViews);

  const before = new Map<string, number>();
  const after = new Map<string, number>();
  for (const r of oldRows) {
    before.set(r.buyerId, (before.get(r.buyerId) ?? 0) + 1);
    before.set(r.supplierId, (before.get(r.supplierId) ?? 0) + 1);
  }
  for (const r of newRows) {
    after.set(r.buyerId, (after.get(r.buyerId) ?? 0) + 1);
    after.set(r.supplierId, (after.get(r.supplierId) ?? 0) + 1);
  }
  const countChanges: CountChange[] = [];
  for (const personId of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(personId) ?? 0;
    const a = after.get(personId) ?? 0;
    if (a === b) continue;
    countChanges.push({
      personId,
      name: name(personId),
      type: supplierIds.has(personId) ? "supplier" : "buyer",
      before: b,
      after: a,
    });
  }
  countChanges.sort((x, y) => compareNames(x.name, y.name) || (x.type === y.type ? 0 : x.type === "buyer" ? -1 : 1));

  return { added, removed, countChanges };
}

class VersionConflict extends Error {}

/**
 * Marks one appointment as reviewed. A marker only: it doesn't change matching
 * (D106 plain runs start from scratch, D107 keep existing keeps every meeting).
 * Bumps the run version and restamps the stats like every other schedule save
 * (D11, D33): the update only fires while the version is still the one read
 * here (and the one the client sent, when it sent one), so a concurrent edit
 * makes it a conflict.
 */
export async function setPinned(
  db: Db,
  input: { appointmentId: string; pinned: boolean; adminId: string; version?: number },
): Promise<ActionResult<{ appointmentId: string; pinned: boolean; version: number }>> {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, input.appointmentId)).limit(1);
  if (!row) return fail("not_found", "That appointment no longer exists. Reload the schedule.");
  const [run, event] = await Promise.all([findRun(db, row.runId), getEvent(row.eventId, db)]);
  if (!run || !event) return fail("not_found", "That run no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return locked;
  if (!run.isActive) return fail("conflict", NOT_ACTIVE_RUN_MESSAGE);
  if (input.version !== undefined && input.version !== run.version) {
    return fail("conflict", VERSION_CONFLICT_MESSAGE);
  }
  if (row.pinned === input.pinned) {
    return ok({ appointmentId: row.id, pinned: row.pinned, version: run.version });
  }

  try {
    const version = await db.transaction(async (tx) => {
      await claimEditableEvent(tx, row.eventId);
      const roster = await loadRoster(tx, row.eventId);
      if (!roster) throw new EventChangedError();
      const rows = await tx.select().from(appointments).where(eq(appointments.runId, run.id));
      const stats = computeStats(rows, {
        settings: roster.event.settings,
        buyers: toEngineBuyers(roster.participants),
        suppliers: toEngineSuppliers(roster.suppliers),
      });
      const [bumped] = await tx
        .update(matchRuns)
        .set({ version: sql`${matchRuns.version} + 1`, stats })
        .where(and(eq(matchRuns.id, run.id), eq(matchRuns.version, run.version), eq(matchRuns.isActive, true)))
        .returning({ version: matchRuns.version });
      if (!bumped) throw new VersionConflict();
      await tx.update(appointments).set({ pinned: input.pinned }).where(eq(appointments.id, row.id));
      await recordAudit(tx, {
        eventId: row.eventId,
        adminId: input.adminId,
        action: input.pinned ? "appointment.pin" : "appointment.unpin",
        entityType: "appointment",
        entityId: row.id,
        before: { pinned: row.pinned },
        after: { pinned: input.pinned, slot: row.slot, buyerId: row.buyerId, supplierId: row.supplierId },
      });
      return bumped.version;
    });
    return ok({ appointmentId: row.id, pinned: input.pinned, version });
  } catch (error) {
    if (error instanceof EventChangedError) return fail("conflict", EVENT_CHANGED_MESSAGE);
    if (error instanceof VersionConflict) {
      const current = await findRun(db, run.id);
      return fail("conflict", current?.isActive ? VERSION_CONFLICT_MESSAGE : NOT_ACTIVE_RUN_MESSAGE);
    }
    throw error;
  }
}
