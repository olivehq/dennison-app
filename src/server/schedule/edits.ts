import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  appointments,
  auditEvents,
  matchRuns,
  type Appointment,
  type Event,
  type MatchRun,
  type Participant,
  type Supplier,
} from "@/db/schema";
import {
  buildRankingIndex,
  computeStats,
  findConflicts,
  isEligible,
  type Appointment as EngineAppointment,
  type Conflict,
  type EligibilityContext,
  type RankingIndex,
} from "@/engine";
import { fail, ok, type ActionResult } from "@/lib/errors";
import {
  NOT_ACTIVE_RUN_MESSAGE,
  VERSION_CONFLICT_MESSAGE,
  type AddAppointmentInput,
  type RemoveAppointmentInput,
  type ReplaceAppointmentInput,
  type SwapCandidatesInput,
} from "@/lib/schemas/schedule";
import { recordAudit } from "@/server/audit/audit";
import { compareNames } from "@/lib/names";
import {
  assertEventEditable,
  claimEditableEvent,
  EVENT_CHANGED_MESSAGE,
  EventChangedError,
} from "@/server/events/editable";
import { isUniqueViolation } from "@/server/matching/common";
import {
  loadRoster,
  toEngineBuyers,
  toEngineRankings,
  toEngineSuppliers,
  type Roster,
} from "@/server/matching/input";
import { findRun } from "@/server/matching/runs";
import { undoNote } from "./undo-note";
import { matchStrength, type MatchStrength } from "./views";

/**
 * Manual schedule edits (scope 2.5, docs/ARCHITECTURE.md "Request flow for a
 * manual edit"). Every edit: check the version (D11), check eligibility and
 * the hard rules with the engine, then write rows, version, stats, and the
 * audit row (D12) in one transaction. The unique indexes stay the authority.
 */

export { VERSION_CONFLICT_MESSAGE };

export type AffectedPerson = {
  personId: string;
  type: "buyer" | "supplier";
  name: string;
  before: number;
  after: number;
};

export type EditResult = {
  runId: string;
  eventId: string;
  version: number;
  affected: AffectedPerson[];
  auditEventId: string;
};

/** What an `appointment.*` audit row stores in `before` and `after`. Undo replays it (D12). */
export const appointmentSnapshotSchema = z.object({
  runId: z.uuid(),
  slot: z.int().min(1),
  buyerId: z.uuid(),
  supplierId: z.uuid(),
  buyerRank: z.number().int().nullable(),
  supplierRank: z.number().int().nullable(),
  source: z.enum(["engine", "manual"]),
  pinned: z.boolean(),
});
export type AppointmentSnapshot = z.infer<typeof appointmentSnapshotSchema>;

export const UNDOABLE_ACTIONS: ReadonlySet<string> = new Set([
  "appointment.replace",
  "appointment.add",
  "appointment.remove",
  "appointment.undo",
]);

type EditOptions = {
  /** Set by `undoAudit`: the row is recorded as `appointment.undo` pointing at this audit id. */
  undoOf?: string;
  /** Set by `undoAudit` when it re-adds a removed appointment that was pinned. */
  pinned?: boolean;
};

type EditContext = {
  run: MatchRun;
  event: Event;
  roster: Roster;
  rows: Appointment[];
  index: RankingIndex;
  eligibility: EligibilityContext;
  buyerById: Map<string, Participant>;
  supplierById: Map<string, Supplier>;
};

function snapshot(row: Appointment): AppointmentSnapshot {
  return {
    runId: row.runId,
    slot: row.slot,
    buyerId: row.buyerId,
    supplierId: row.supplierId,
    buyerRank: row.buyerRank,
    supplierRank: row.supplierRank,
    source: row.source,
    pinned: row.pinned,
  };
}

function toEngineRow(row: Pick<Appointment, "slot" | "buyerId" | "supplierId" | "buyerRank" | "supplierRank" | "source" | "pinned">): EngineAppointment {
  return {
    slot: row.slot,
    buyerId: row.buyerId,
    supplierId: row.supplierId,
    buyerRank: row.buyerRank,
    supplierRank: row.supplierRank,
    source: row.source,
    pinned: row.pinned,
  };
}

async function loadContext(db: Db, runId: string): Promise<ActionResult<EditContext>> {
  const run = await findRun(db, runId);
  if (!run) return fail("not_found", "That run no longer exists. Reload the schedule.");
  if (run.status !== "completed") return fail("validation", "That run did not complete, so it cannot be edited.");
  const roster = await loadRoster(db, run.eventId);
  if (!roster) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(roster.event);
  if (locked) return locked;
  // D33: only the active run is edited, so a colleague's activation stops stale editors.
  if (!run.isActive) return fail("conflict", NOT_ACTIVE_RUN_MESSAGE);
  const rows = await db.select().from(appointments).where(eq(appointments.runId, run.id));
  const index = buildRankingIndex(toEngineRankings(roster.rankings));
  return ok({
    run,
    event: roster.event,
    roster,
    rows,
    index,
    eligibility: { index, settings: roster.event.settings },
    buyerById: new Map(roster.participants.map((p) => [p.id, p])),
    supplierById: new Map(roster.suppliers.map((s) => [s.id, s])),
  });
}

function checkVersion(ctx: EditContext, version: number): ActionResult<never> | null {
  return ctx.run.version === version ? null : fail("conflict", VERSION_CONFLICT_MESSAGE);
}

function checkSlot(ctx: EditContext, slot: number): ActionResult<never> | null {
  if (slot >= 1 && slot <= ctx.event.settings.slotCount) return null;
  return fail("validation", `Slot ${slot} does not exist. This event has ${ctx.event.settings.slotCount} slots.`);
}

/** Scope 2.2 step 1 through the engine's `isEligible`, with a reason an admin can act on. */
function checkEligible(ctx: EditContext, buyerId: string, supplierId: string): ActionResult<never> | null {
  const buyer = ctx.buyerById.get(buyerId);
  const supplier = ctx.supplierById.get(supplierId);
  if (!buyer) return fail("not_found", "That buyer is not on this event's roster.");
  if (!supplier) return fail("not_found", "That supplier is not on this event's roster.");
  const name = (id: string) => ctx.roster.names.get(id) ?? id;
  if (buyer.status === "withdrawn") return fail("conflict", `${name(buyer.id)} has withdrawn.`);
  if (supplier.status === "withdrawn") return fail("conflict", `${name(supplier.id)} has withdrawn.`);
  if (ctx.index.isRejected(buyer.id, supplier.id)) {
    return fail("conflict", `${name(buyer.id)} marked ${name(supplier.id)} as N/A.`);
  }
  const eligible = isEligible(
    { id: buyer.id, biztechOptIn: buyer.biztechOptIn },
    { id: supplier.id, type: supplier.type },
    ctx.eligibility,
  );
  if (!eligible) {
    return fail(
      "conflict",
      `${name(buyer.id)} is not opted in to biztech, and ${name(supplier.id)} is a business supplier.`,
    );
  }
  return null;
}

function describeConflict(ctx: EditContext, conflict: Conflict, changed: { buyerId: string; supplierId: string }): string {
  const name = (id: string) => ctx.roster.names.get(id) ?? id;
  switch (conflict.kind) {
    case "buyer_double_booked": {
      const other = conflict.supplierIds.find((id) => id !== changed.supplierId) ?? conflict.supplierIds[0];
      return `${name(conflict.buyerId)} is already booked in slot ${conflict.slot} with ${name(other)}.`;
    }
    case "supplier_double_booked": {
      const other = conflict.buyerIds.find((id) => id !== changed.buyerId) ?? conflict.buyerIds[0];
      return `${name(conflict.supplierId)} already has ${name(other)} in slot ${conflict.slot}.`;
    }
    case "duplicate_pair":
      return `${name(conflict.buyerId)} and ${name(conflict.supplierId)} already meet in slot ${conflict.slots.join(" and ")}.`;
  }
}

/** The hard rules, checked by the engine on the schedule as it would be after the edit. */
function checkConflicts(
  ctx: EditContext,
  wouldBe: EngineAppointment[],
  changed: { buyerId: string; supplierId: string },
): ActionResult<never> | null {
  const conflicts = findConflicts(wouldBe);
  if (conflicts.length === 0) return null;
  return fail("conflict", describeConflict(ctx, conflicts[0], changed));
}

function countsFor(rows: { buyerId: string; supplierId: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.buyerId, (counts.get(r.buyerId) ?? 0) + 1);
    counts.set(r.supplierId, (counts.get(r.supplierId) ?? 0) + 1);
  }
  return counts;
}

function affectedPeople(
  ctx: EditContext,
  wouldBe: EngineAppointment[],
  touched: { buyerIds: string[]; supplierIds: string[] },
): AffectedPerson[] {
  const before = countsFor(ctx.rows);
  const after = countsFor(wouldBe);
  const people: AffectedPerson[] = [];
  const add = (personId: string, type: AffectedPerson["type"]) => {
    if (people.some((p) => p.personId === personId)) return;
    people.push({
      personId,
      type,
      name: ctx.roster.names.get(personId) ?? personId,
      before: before.get(personId) ?? 0,
      after: after.get(personId) ?? 0,
    });
  };
  for (const id of touched.buyerIds) add(id, "buyer");
  for (const id of touched.supplierIds) add(id, "supplier");
  return people;
}

class VersionConflict extends Error {}

type Change = {
  deleteIds: string[];
  insert: Omit<EngineAppointment, "source"> | null;
  audit: {
    action: string;
    before: AppointmentSnapshot | null;
    note: string | null;
    /** Extra keys for the audit `after`, beside the inserted row's snapshot. */
    after?: Record<string, unknown>;
  };
  touched: { buyerIds: string[]; supplierIds: string[] };
};

/**
 * One transaction: claim the event as still editable, bump the version only
 * if it still matches and the run is still active (the real optimistic
 * lock), apply the row changes, store fresh stats, audit.
 */
async function commit(
  db: Db,
  ctx: EditContext,
  wouldBe: EngineAppointment[],
  change: Change,
  adminId: string,
  options: EditOptions,
): Promise<ActionResult<EditResult>> {
  const stats = computeStats(wouldBe, {
    settings: ctx.event.settings,
    buyers: toEngineBuyers(ctx.roster.participants),
    suppliers: toEngineSuppliers(ctx.roster.suppliers),
  });
  const affected = affectedPeople(ctx, wouldBe, change.touched);

  try {
    const { version, auditEventId } = await db.transaction(async (tx) => {
      await claimEditableEvent(tx, ctx.event.id);
      const [bumped] = await tx
        .update(matchRuns)
        .set({ version: ctx.run.version + 1, stats })
        .where(and(eq(matchRuns.id, ctx.run.id), eq(matchRuns.version, ctx.run.version), eq(matchRuns.isActive, true)))
        .returning({ version: matchRuns.version });
      if (!bumped) throw new VersionConflict();

      for (const id of change.deleteIds) {
        await tx.delete(appointments).where(eq(appointments.id, id));
      }
      let inserted: Appointment | null = null;
      if (change.insert) {
        [inserted] = await tx
          .insert(appointments)
          .values({
            runId: ctx.run.id,
            eventId: ctx.event.id,
            slot: change.insert.slot,
            buyerId: change.insert.buyerId,
            supplierId: change.insert.supplierId,
            buyerRank: change.insert.buyerRank,
            supplierRank: change.insert.supplierRank,
            source: "manual",
            pinned: change.insert.pinned,
          })
          .returning();
      }
      const audit = await recordAudit(tx, {
        eventId: ctx.event.id,
        adminId,
        action: options.undoOf ? "appointment.undo" : change.audit.action,
        entityType: "appointment",
        entityId: inserted?.id ?? change.deleteIds[0] ?? null,
        before: change.audit.before,
        after: inserted ? { ...snapshot(inserted), ...change.audit.after } : null,
        note: options.undoOf ? undoNote(options.undoOf) : change.audit.note,
      });
      return { version: bumped.version, auditEventId: audit.id };
    });
    return ok({ runId: ctx.run.id, eventId: ctx.event.id, version, affected, auditEventId });
  } catch (error) {
    if (error instanceof EventChangedError) return fail("conflict", EVENT_CHANGED_MESSAGE);
    if (error instanceof VersionConflict) {
      const current = await findRun(db, ctx.run.id);
      return fail("conflict", current?.isActive ? VERSION_CONFLICT_MESSAGE : NOT_ACTIVE_RUN_MESSAGE);
    }
    if (isUniqueViolation(error)) {
      return fail("conflict", "Another change got there first and this one would double book. Reload and try again.");
    }
    throw error;
  }
}

function findRow(ctx: EditContext, slot: number, supplierId: string, buyerId: string): Appointment | null {
  return ctx.rows.find((r) => r.slot === slot && r.supplierId === supplierId && r.buyerId === buyerId) ?? null;
}

function stamped(
  ctx: EditContext,
  slot: number,
  buyerId: string,
  supplierId: string,
  pinned = false,
): EngineAppointment {
  return {
    slot,
    buyerId,
    supplierId,
    buyerRank: ctx.index.buyerRank(buyerId, supplierId),
    supplierRank: ctx.index.supplierRank(supplierId, buyerId),
    source: "manual",
    pinned,
  };
}

/** Removes `removeBuyerId` from the supplier's slot and books `addBuyerId` in its place. */
export async function replaceAppointment(
  db: Db,
  input: ReplaceAppointmentInput,
  adminId: string,
  options: EditOptions = {},
): Promise<ActionResult<EditResult>> {
  const loaded = await loadContext(db, input.runId);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  const stale = checkVersion(ctx, input.version);
  if (stale) return stale;
  if (input.removeBuyerId === input.addBuyerId) {
    return fail("validation", "Pick a different buyer to replace this one with.");
  }
  const existing = findRow(ctx, input.slot, input.supplierId, input.removeBuyerId);
  if (!existing) return fail("not_found", "That appointment no longer exists. Reload the schedule.");
  const ineligible = checkEligible(ctx, input.addBuyerId, input.supplierId);
  if (ineligible) return ineligible;

  // A pinned slot stays pinned: the admin protected the slot, and the replacement is a deliberate choice too.
  const added = stamped(ctx, input.slot, input.addBuyerId, input.supplierId, existing.pinned);
  const wouldBe = [...ctx.rows.filter((r) => r.id !== existing.id).map(toEngineRow), added];
  const conflict = checkConflicts(ctx, wouldBe, added);
  if (conflict) return conflict;

  return commit(
    db,
    ctx,
    wouldBe,
    {
      deleteIds: [existing.id],
      insert: added,
      audit: {
        action: "appointment.replace",
        before: snapshot(existing),
        note: input.note ?? null,
        after: existing.pinned ? { pinKept: true } : undefined,
      },
      touched: { buyerIds: [input.removeBuyerId, input.addBuyerId], supplierIds: [input.supplierId] },
    },
    adminId,
    options,
  );
}

/** Fills an open supplier slot. */
export async function addAppointment(
  db: Db,
  input: AddAppointmentInput,
  adminId: string,
  options: EditOptions = {},
): Promise<ActionResult<EditResult>> {
  const loaded = await loadContext(db, input.runId);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  const stale = checkVersion(ctx, input.version);
  if (stale) return stale;
  const badSlot = checkSlot(ctx, input.slot);
  if (badSlot) return badSlot;
  const ineligible = checkEligible(ctx, input.buyerId, input.supplierId);
  if (ineligible) return ineligible;

  const added = stamped(ctx, input.slot, input.buyerId, input.supplierId, options.pinned ?? false);
  const wouldBe = [...ctx.rows.map(toEngineRow), added];
  const conflict = checkConflicts(ctx, wouldBe, added);
  if (conflict) return conflict;

  return commit(
    db,
    ctx,
    wouldBe,
    {
      deleteIds: [],
      insert: added,
      audit: { action: "appointment.add", before: null, note: input.note ?? null },
      touched: { buyerIds: [input.buyerId], supplierIds: [input.supplierId] },
    },
    adminId,
    options,
  );
}

/** Leaves the supplier's slot open. */
export async function removeAppointment(
  db: Db,
  input: RemoveAppointmentInput,
  adminId: string,
  options: EditOptions = {},
): Promise<ActionResult<EditResult>> {
  const loaded = await loadContext(db, input.runId);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  const stale = checkVersion(ctx, input.version);
  if (stale) return stale;
  const existing = findRow(ctx, input.slot, input.supplierId, input.buyerId);
  if (!existing) return fail("not_found", "That appointment no longer exists. Reload the schedule.");

  const wouldBe = ctx.rows.filter((r) => r.id !== existing.id).map(toEngineRow);
  return commit(
    db,
    ctx,
    wouldBe,
    {
      deleteIds: [existing.id],
      insert: null,
      audit: { action: "appointment.remove", before: snapshot(existing), note: input.note ?? null },
      touched: { buyerIds: [input.buyerId], supplierIds: [input.supplierId] },
    },
    adminId,
    options,
  );
}

export type SwapCandidate = {
  buyerId: string;
  name: string;
  organization: string | null;
  title: string | null;
  biztechOptIn: boolean;
  buyerRank: number | null;
  supplierRank: number | null;
  strength: MatchStrength;
  /** Current appointment count and what it becomes if picked. */
  count: number;
  countAfter: number;
};

function combinedRankKey(c: { buyerRank: number | null; supplierRank: number | null }): [number, number] {
  const b = c.buyerRank;
  const s = c.supplierRank;
  if (b !== null && s !== null) return [0, b + s];
  if (b !== null) return [1, b];
  if (s !== null) return [1, s];
  return [2, 0];
}

/**
 * Buyers an admin can put in a supplier's slot (scope 2.5): active, free in
 * that slot, not already paired with the supplier, eligible. Best combined
 * rank first, blanks last, then the buyer with the fewest appointments.
 */
export async function swapCandidates(db: Db, input: SwapCandidatesInput): Promise<ActionResult<SwapCandidate[]>> {
  const run = await findRun(db, input.runId);
  if (!run) return fail("not_found", "That run no longer exists. Reload the schedule.");
  const roster = await loadRoster(db, run.eventId);
  if (!roster) return fail("not_found", "That event no longer exists.");
  const supplier = roster.suppliers.find((s) => s.id === input.supplierId);
  if (!supplier) return fail("not_found", "That supplier is not on this event's roster.");
  const rows = await db.select().from(appointments).where(eq(appointments.runId, run.id));
  const index = buildRankingIndex(toEngineRankings(roster.rankings));
  const eligibility: EligibilityContext = { index, settings: roster.event.settings };
  const n = roster.event.settings.mutualTopN;

  const busyInSlot = new Set(rows.filter((r) => r.slot === input.slot).map((r) => r.buyerId));
  const pairedWithSupplier = new Set(rows.filter((r) => r.supplierId === supplier.id).map((r) => r.buyerId));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.buyerId, (counts.get(r.buyerId) ?? 0) + 1);
  const engineSupplier = { id: supplier.id, type: supplier.type, withdrawn: supplier.status === "withdrawn" };

  const candidates: SwapCandidate[] = [];
  for (const p of roster.participants) {
    if (p.status !== "active") continue;
    if (p.id === input.excludeBuyerId) continue;
    if (busyInSlot.has(p.id) || pairedWithSupplier.has(p.id)) continue;
    if (!isEligible({ id: p.id, biztechOptIn: p.biztechOptIn }, engineSupplier, eligibility)) continue;
    const buyerRank = index.buyerRank(p.id, supplier.id);
    const supplierRank = index.supplierRank(supplier.id, p.id);
    const count = counts.get(p.id) ?? 0;
    candidates.push({
      buyerId: p.id,
      name: roster.names.get(p.id) ?? p.id,
      organization: p.organization,
      title: p.title,
      biztechOptIn: p.biztechOptIn,
      buyerRank,
      supplierRank,
      strength: matchStrength(buyerRank, supplierRank, n),
      count,
      countAfter: count + 1,
    });
  }
  candidates.sort((a, b) => {
    const [tierA, sumA] = combinedRankKey(a);
    const [tierB, sumB] = combinedRankKey(b);
    return tierA - tierB || sumA - sumB || a.count - b.count || compareNames(a.name, b.name);
  });
  return ok(candidates);
}

export { undoNote };

function parseSnapshot(value: unknown): AppointmentSnapshot | null {
  if (value === null || value === undefined) return null;
  const parsed = appointmentSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Replays `before` of a schedule edit through the same edit functions, so the
 * hard rules and the version bump apply (D12). Refused when the run is no
 * longer active, the event is locked, or the change was already undone.
 * `version` is the run version the client read; when sent, a stale one is the
 * usual version conflict (D11). Optional for one release.
 */
export async function undoAudit(
  db: Db,
  input: { auditEventId: string; adminId: string; version?: number },
): Promise<ActionResult<EditResult>> {
  const [row] = await db.select().from(auditEvents).where(eq(auditEvents.id, input.auditEventId)).limit(1);
  if (!row) return fail("not_found", "That activity entry no longer exists.");
  if (!UNDOABLE_ACTIONS.has(row.action) || row.entityType !== "appointment") {
    return fail("validation", "Only schedule edits can be undone.");
  }
  const before = parseSnapshot(row.before);
  const after = parseSnapshot(row.after);
  const runId = before?.runId ?? after?.runId;
  if (!runId) return fail("validation", "This entry has nothing to replay.");

  const run = await findRun(db, runId);
  if (!run) return fail("not_found", "That run no longer exists.");
  if (!run.isActive) return fail("conflict", "That change belongs to a run that is no longer active.");
  if (input.version !== undefined && input.version !== run.version) return fail("conflict", VERSION_CONFLICT_MESSAGE);

  const [alreadyUndone] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "appointment.undo"), eq(auditEvents.note, undoNote(row.id))))
    .limit(1);
  if (alreadyUndone) return fail("conflict", "That change was already undone.");

  const options: EditOptions = { undoOf: row.id };
  const common = { runId: run.id, version: run.version };
  if (before && after) {
    return replaceAppointment(
      db,
      {
        ...common,
        slot: before.slot,
        supplierId: before.supplierId,
        removeBuyerId: after.buyerId,
        addBuyerId: before.buyerId,
      },
      input.adminId,
      options,
    );
  }
  if (after) {
    return removeAppointment(
      db,
      { ...common, slot: after.slot, supplierId: after.supplierId, buyerId: after.buyerId },
      input.adminId,
      options,
    );
  }
  if (before) {
    return addAppointment(
      db,
      { ...common, slot: before.slot, supplierId: before.supplierId, buyerId: before.buyerId },
      input.adminId,
      { ...options, pinned: before.pinned },
    );
  }
  return fail("validation", "This entry has nothing to replay.");
}
