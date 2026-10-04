import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, matchRuns, type MatchRun } from "@/db/schema";
import { runMatching, type Appointment, type QualityStats } from "@/engine";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { compareNames } from "@/lib/names";
import { NOT_ACTIVE_RUN_MESSAGE, VERSION_CONFLICT_MESSAGE } from "@/lib/schemas/schedule";
import { recordAudit } from "@/server/audit/audit";
import {
  assertEventEditable,
  claimEditableEvent,
  EVENT_CHANGED_MESSAGE,
  EventChangedError,
} from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { advanceStatus } from "@/server/events/status";
import { isUniqueViolation, nameWarning } from "./common";
import { buildMatchInput, loadRoster, type Roster } from "./input";
import { matchingReadiness } from "./readiness";

export type StartRunInput = {
  eventId: string;
  adminId: string;
  /** D10: pin every appointment of the active run that involves no withdrawn person. */
  keepExisting: boolean;
};

export type StartRunResult = {
  runId: string;
  isActive: boolean;
  stats: QualityStats;
  warnings: string[];
  durationMs: number;
  pinnedCount: number;
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

export async function findActiveRun(db: Db, eventId: string): Promise<MatchRun | null> {
  const [run] = await db
    .select()
    .from(matchRuns)
    .where(and(eq(matchRuns.eventId, eventId), eq(matchRuns.isActive, true)))
    .limit(1);
  return run ?? null;
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

/**
 * Marks runs that are still `running` after `minutes` as failed with the
 * warning "Timed out". The running row is inserted before the engine starts so
 * the page can show it; a crash or a killed function leaves it behind.
 */
export async function failRunsOlderThan(db: Db, minutes: number, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = await db
    .update(matchRuns)
    .set({ status: "failed", warnings: ["Timed out"], completedAt: now })
    .where(and(eq(matchRuns.status, "running"), lt(matchRuns.createdAt, cutoff)))
    .returning({ id: matchRuns.id });
  return rows.length;
}

/**
 * Appointments of the active run that survive a re-run (D10): anything that
 * names a withdrawn buyer or supplier is dropped so its slots can be refilled.
 */
async function loadPinnedFromActiveRun(
  db: Db,
  roster: Roster,
  activeRunId: string,
): Promise<Appointment[]> {
  const withdrawn = new Set<string>([
    ...roster.participants.filter((p) => p.status === "withdrawn").map((p) => p.id),
    ...roster.suppliers.filter((s) => s.status === "withdrawn").map((s) => s.id),
  ]);
  const rows = await db.select().from(appointments).where(eq(appointments.runId, activeRunId));
  return rows
    .filter((r) => !withdrawn.has(r.buyerId) && !withdrawn.has(r.supplierId))
    .map((r) => ({
      slot: r.slot,
      buyerId: r.buyerId,
      supplierId: r.supplierId,
      buyerRank: r.buyerRank,
      supplierRank: r.supplierRank,
      source: r.source,
      pinned: true,
    }));
}

/**
 * Runs the engine and stores the result as a new `match_runs` row. The first
 * completed run of an event becomes active on its own; later runs wait for
 * `activateRun` so an admin can compare first (scope 2.2 re-run addition).
 */
export async function startRun(db: Db, input: StartRunInput): Promise<ActionResult<StartRunResult>> {
  const roster = await loadRoster(db, input.eventId);
  if (!roster) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(roster.event);
  if (locked) return locked;
  const readiness = await matchingReadiness(db, input.eventId);
  if (!readiness.ready) return fail("validation", readiness.reasons.join(" "));

  let pinned: Appointment[] = [];
  let parentRunId: string | null = null;
  if (input.keepExisting) {
    const active = await findActiveRun(db, input.eventId);
    if (!active) {
      return fail(
        "validation",
        "There is no active run to keep. Run matching without keeping existing appointments.",
      );
    }
    parentRunId = active.id;
    pinned = await loadPinnedFromActiveRun(db, roster, active.id);
  }

  const [run] = await db
    .insert(matchRuns)
    .values({
      eventId: input.eventId,
      status: "running",
      settingsSnapshot: roster.event.settings,
      parentRunId,
      createdBy: input.adminId,
    })
    .returning();

  try {
    const started = performance.now();
    const result = runMatching(buildMatchInput(roster, pinned));
    const durationMs = Math.round(performance.now() - started);
    const warnings = result.warnings.map((w) => nameWarning(w, roster.names));

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
      const makeActive = (await findActiveRun(tx, input.eventId)) === null && (await setActiveFlag(tx, run.id));
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
          pinnedCount: pinned.length,
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
      pinnedCount: pinned.length,
    });
  } catch (error) {
    const changed = error instanceof EventChangedError;
    const message = changed
      ? "The event was locked or archived while matching ran."
      : error instanceof Error
        ? error.message
        : String(error);
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
    return fail("internal", "Matching failed. The run is marked failed; open it to see the error.");
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

/**
 * Makes one run the schedule everyone sees and edits. Clears the flag on every
 * other run of the event, all in one transaction that first claims the event
 * as editable. The partial unique index on the active run is the authority: a
 * concurrent activation that slips past becomes a conflict, never two actives.
 */
export async function activateRun(
  db: Db,
  input: { runId: string; adminId: string },
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
  countChanges.sort((x, y) => x.type.localeCompare(y.type) || compareNames(x.name, y.name));

  return { added, removed, countChanges };
}

class VersionConflict extends Error {}

/**
 * Protects one appointment from the next "re-run and keep existing" (scope 2.2).
 * Bumps the run version like every other schedule save (D11, D33): the update
 * only fires while the version is still the one read here (and the one the
 * client sent, when it sent one), so a concurrent edit makes it a conflict.
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
      const [bumped] = await tx
        .update(matchRuns)
        .set({ version: sql`${matchRuns.version} + 1` })
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
