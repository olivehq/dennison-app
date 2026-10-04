import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { appointments, events, matchRuns, type Event, type MatchRun } from "@/db/schema";
import { runMatching, type Appointment, type QualityStats } from "@/engine";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit";
import { assertEventEditable } from "@/server/events/editable";
import { compareNames, loadEvent, nameWarning } from "./common";
import { buildMatchInput, loadRoster, type Roster } from "./input";

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

/** An event with an active run has been matched. Only `imported` moves; later statuses stay. */
async function markMatched(tx: Tx, event: Pick<Event, "id" | "status">): Promise<void> {
  if (event.status !== "imported") return;
  await tx.update(events).set({ status: "matched" }).where(eq(events.id, event.id));
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
      const current = await findActiveRun(tx, input.eventId);
      const makeActive = current === null;
      await tx
        .update(matchRuns)
        .set({
          status: "completed",
          stats: result.stats,
          warnings,
          durationMs,
          isActive: makeActive,
          completedAt: new Date(),
        })
        .where(eq(matchRuns.id, run.id));
      if (makeActive) await markMatched(tx, roster.event);
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
    const message = error instanceof Error ? error.message : String(error);
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
    return fail("internal", "Matching failed. The run is marked failed; open it to see the error.");
  }
}

/** Makes one run the schedule everyone sees and edits. Clears the flag on every other run of the event. */
export async function activateRun(
  db: Db,
  input: { runId: string; adminId: string },
): Promise<ActionResult<{ runId: string }>> {
  const run = await findRun(db, input.runId);
  if (!run) return fail("not_found", "That run no longer exists.");
  if (run.status !== "completed") return fail("validation", "Only a completed run can be activated.");
  const event = await loadEvent(db, run.eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return locked;
  if (run.isActive) return ok({ runId: run.id });

  await db.transaction(async (tx) => {
    const previous = await findActiveRun(tx, run.eventId);
    await tx
      .update(matchRuns)
      .set({ isActive: false })
      .where(and(eq(matchRuns.eventId, run.eventId), eq(matchRuns.isActive, true)));
    await tx.update(matchRuns).set({ isActive: true }).where(eq(matchRuns.id, run.id));
    await markMatched(tx, event);
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
  const name = (id: string) => roster.names.get(id) ?? id;
  const toView = (r: (typeof newRows)[number]): AppointmentView => ({
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
  const supplierIds = new Set(roster.suppliers.map((s) => s.id));
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

  return ok({ added, removed, countChanges });
}

/** Protects one appointment from the next "re-run and keep existing" (scope 2.2). Bumps the run version. */
export async function setPinned(
  db: Db,
  input: { appointmentId: string; pinned: boolean; adminId: string },
): Promise<ActionResult<{ appointmentId: string; pinned: boolean; version: number }>> {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, input.appointmentId)).limit(1);
  if (!row) return fail("not_found", "That appointment no longer exists. Reload the schedule.");
  const [run, event] = await Promise.all([findRun(db, row.runId), loadEvent(db, row.eventId)]);
  if (!run || !event) return fail("not_found", "That run no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return locked;
  if (row.pinned === input.pinned) {
    return ok({ appointmentId: row.id, pinned: row.pinned, version: run.version });
  }

  const version = await db.transaction(async (tx) => {
    await tx.update(appointments).set({ pinned: input.pinned }).where(eq(appointments.id, row.id));
    const [updated] = await tx
      .update(matchRuns)
      .set({ version: run.version + 1 })
      .where(eq(matchRuns.id, run.id))
      .returning({ version: matchRuns.version });
    await recordAudit(tx, {
      eventId: row.eventId,
      adminId: input.adminId,
      action: input.pinned ? "appointment.pin" : "appointment.unpin",
      entityType: "appointment",
      entityId: row.id,
      before: { pinned: row.pinned },
      after: { pinned: input.pinned, slot: row.slot, buyerId: row.buyerId, supplierId: row.supplierId },
    });
    return updated.version;
  });
  return ok({ appointmentId: row.id, pinned: input.pinned, version });
}
