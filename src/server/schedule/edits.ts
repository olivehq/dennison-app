import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  appointments,
  auditEvents,
  matchRuns,
  rankings,
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
import { assertEventEditable, inEventTransaction, Refused } from "@/server/events/editable";
import { isUniqueViolation } from "@/server/matching/common";
import {
  loadPeople,
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
  /** Set by `undoAudit` when it puts back an appointment that was pinned (after a remove or a replace). */
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

/** Why an undo can't put a withdrawn person back, and where to restore them. */
function undoWithdrawnMessage(name: string, page: "Participants" | "Suppliers"): string {
  return `${name} has withdrawn, so this change can't be undone. Restore them on the ${page} page first, or leave the slot as it is.`;
}

/**
 * Scope 2.2 step 1 through the engine's `isEligible`, with a reason an admin
 * can act on. `undo` words a withdrawal as a refused undo (D12).
 */
function checkEligible(ctx: EditContext, buyerId: string, supplierId: string, undo = false): ActionResult<never> | null {
  const buyer = ctx.buyerById.get(buyerId);
  const supplier = ctx.supplierById.get(supplierId);
  if (!buyer) return fail("not_found", "That buyer is not on this event's roster.");
  if (!supplier) return fail("not_found", "That supplier is not on this event's roster.");
  const name = (id: string) => ctx.roster.names.get(id) ?? id;
  if (buyer.status === "withdrawn") {
    return fail("conflict", undo ? undoWithdrawnMessage(name(buyer.id), "Participants") : `${name(buyer.id)} has withdrawn.`);
  }
  if (supplier.status === "withdrawn") {
    return fail("conflict", undo ? undoWithdrawnMessage(name(supplier.id), "Suppliers") : `${name(supplier.id)} has withdrawn.`);
  }
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

/** Appended to a hard-rule conflict when an undo hits it, so the admin knows the way out. */
export const UNDO_CONFLICT_HINT = "Move or remove that meeting first, then undo again.";

/** The hard rules, checked by the engine on the schedule as it would be after the edit. */
function checkConflicts(
  ctx: EditContext,
  wouldBe: EngineAppointment[],
  changed: { buyerId: string; supplierId: string },
  undo = false,
): ActionResult<never> | null {
  const conflicts = findConflicts(wouldBe);
  if (conflicts.length === 0) return null;
  const message = describeConflict(ctx, conflicts[0], changed);
  return fail("conflict", undo ? `${message} ${UNDO_CONFLICT_HINT}` : message);
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

/** What an edit would do to the schedule, or why it can't. */
type Plan = { wouldBe: EngineAppointment[]; change: Change };

/**
 * Checks one edit against a context and says what it writes. Pure, so the
 * same checks run on the first read (a quick refusal) and again inside the
 * transaction on what is committed by then.
 */
type Planner = (ctx: EditContext) => ActionResult<Plan>;

/**
 * Loads, checks the version (D11), plans, then commits. The plan on the first
 * read only refuses early; `commit` plans again under the event lock.
 */
async function runEdit(
  db: Db,
  input: { runId: string; version: number },
  planner: Planner,
  adminId: string,
  options: EditOptions,
): Promise<ActionResult<EditResult>> {
  const loaded = await loadContext(db, input.runId);
  if (!loaded.ok) return loaded;
  const stale = checkVersion(loaded.data, input.version);
  if (stale) return stale;
  const planned = planner(loaded.data);
  if (!planned.ok) return planned;
  return commit(db, loaded.data.run, planner, adminId, options);
}

/**
 * One transaction: claim the event as still editable, then read the run,
 * settings, roster, rankings, and rows again and plan the edit on them.
 * Settings saves, withdrawals, and import applies take the same event row
 * but don't bump the run version, so this second plan is what catches a slot
 * that no longer exists, a person who withdrew, or a pair marked N/A since
 * the first read. Then bump the version only if it still matches and the run
 * is still active (the real optimistic lock), apply the row changes, store
 * fresh stats, audit.
 */
async function commit(
  db: Db,
  read: MatchRun,
  planner: Planner,
  adminId: string,
  options: EditOptions,
): Promise<ActionResult<EditResult>> {
  try {
    const saved = await inEventTransaction(db, read.eventId, "edit", async (tx) => {
      const loaded = await loadContext(tx, read.id);
      if (!loaded.ok) throw new Refused(loaded);
      const ctx = loaded.data;
      if (ctx.run.version !== read.version) throw new VersionConflict();
      const planned = planner(ctx);
      if (!planned.ok) throw new Refused(planned);
      const { wouldBe, change } = planned.data;
      const stats = computeStats(wouldBe, {
        settings: ctx.event.settings,
        buyers: toEngineBuyers(ctx.roster.participants),
        suppliers: toEngineSuppliers(ctx.roster.suppliers),
      });

      const [bumped] = await tx
        .update(matchRuns)
        .set({ version: read.version + 1, stats })
        .where(and(eq(matchRuns.id, read.id), eq(matchRuns.version, read.version), eq(matchRuns.isActive, true)))
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
            runId: read.id,
            eventId: read.eventId,
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
        eventId: read.eventId,
        adminId,
        action: options.undoOf ? "appointment.undo" : change.audit.action,
        entityType: "appointment",
        entityId: inserted?.id ?? change.deleteIds[0] ?? null,
        before: change.audit.before,
        after: inserted ? { ...snapshot(inserted), ...change.audit.after } : null,
        note: options.undoOf ? undoNote(options.undoOf) : change.audit.note,
      });
      return {
        version: bumped.version,
        auditEventId: audit.id,
        affected: affectedPeople(ctx, wouldBe, change.touched),
      };
    });
    if (!saved.ok) return saved;
    return ok({ runId: read.id, eventId: read.eventId, ...saved.data });
  } catch (error) {
    if (error instanceof VersionConflict) {
      const current = await findRun(db, read.id);
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
  if (input.removeBuyerId === input.addBuyerId) {
    return fail("validation", "Pick a different buyer to replace this one with.");
  }
  const planner: Planner = (ctx) => {
    const existing = findRow(ctx, input.slot, input.supplierId, input.removeBuyerId);
    if (!existing) return fail("not_found", "That appointment no longer exists. Reload the schedule.");
    const badSlot = checkSlot(ctx, input.slot);
    if (badSlot) return badSlot;
    const ineligible = checkEligible(ctx, input.addBuyerId, input.supplierId, options.undoOf !== undefined);
    if (ineligible) return ineligible;

    // A pin belongs to the meeting it was set on, so the replacement starts unpinned. Undo puts the old pin back.
    const added = stamped(ctx, input.slot, input.addBuyerId, input.supplierId, options.pinned ?? false);
    const wouldBe = [...ctx.rows.filter((r) => r.id !== existing.id).map(toEngineRow), added];
    const conflict = checkConflicts(ctx, wouldBe, added, options.undoOf !== undefined);
    if (conflict) return conflict;
    return ok({
      wouldBe,
      change: {
        deleteIds: [existing.id],
        insert: added,
        audit: {
          action: "appointment.replace",
          before: snapshot(existing),
          note: input.note ?? null,
          after: existing.pinned && !added.pinned ? { pinDropped: true } : undefined,
        },
        touched: { buyerIds: [input.removeBuyerId, input.addBuyerId], supplierIds: [input.supplierId] },
      },
    });
  };
  return runEdit(db, input, planner, adminId, options);
}

/** Fills an open supplier slot. */
export async function addAppointment(
  db: Db,
  input: AddAppointmentInput,
  adminId: string,
  options: EditOptions = {},
): Promise<ActionResult<EditResult>> {
  const planner: Planner = (ctx) => {
    const badSlot = checkSlot(ctx, input.slot);
    if (badSlot) return badSlot;
    const ineligible = checkEligible(ctx, input.buyerId, input.supplierId, options.undoOf !== undefined);
    if (ineligible) return ineligible;

    const added = stamped(ctx, input.slot, input.buyerId, input.supplierId, options.pinned ?? false);
    const wouldBe = [...ctx.rows.map(toEngineRow), added];
    const conflict = checkConflicts(ctx, wouldBe, added, options.undoOf !== undefined);
    if (conflict) return conflict;
    return ok({
      wouldBe,
      change: {
        deleteIds: [],
        insert: added,
        audit: { action: "appointment.add", before: null, note: input.note ?? null },
        touched: { buyerIds: [input.buyerId], supplierIds: [input.supplierId] },
      },
    });
  };
  return runEdit(db, input, planner, adminId, options);
}

/** Leaves the supplier's slot open. */
export async function removeAppointment(
  db: Db,
  input: RemoveAppointmentInput,
  adminId: string,
  options: EditOptions = {},
): Promise<ActionResult<EditResult>> {
  const planner: Planner = (ctx) => {
    const existing = findRow(ctx, input.slot, input.supplierId, input.buyerId);
    if (!existing) return fail("not_found", "That appointment no longer exists. Reload the schedule.");
    return ok({
      wouldBe: ctx.rows.filter((r) => r.id !== existing.id).map(toEngineRow),
      change: {
        deleteIds: [existing.id],
        insert: null,
        audit: { action: "appointment.remove", before: snapshot(existing), note: input.note ?? null },
        touched: { buyerIds: [input.buyerId], supplierIds: [input.supplierId] },
      },
    });
  };
  return runEdit(db, input, planner, adminId, options);
}

/** Someone who can take the slot. `buyerId` and `supplierId` are the pair the pick would book. */
type CandidateBase = {
  buyerId: string;
  supplierId: string;
  /** The candidate's display name (D34 for buyers). */
  name: string;
  buyerRank: number | null;
  supplierRank: number | null;
  strength: MatchStrength;
  /** The candidate's current appointment count and what it becomes if picked. */
  count: number;
  countAfter: number;
};

export type BuyerCandidate = CandidateBase & {
  kind: "buyer";
  organization: string | null;
  title: string | null;
  biztechOptIn: boolean;
};

export type SupplierCandidate = CandidateBase & {
  kind: "supplier";
  supplierType: Supplier["type"];
  desk: number | null;
};

export type SwapCandidate = BuyerCandidate | SupplierCandidate;

function combinedRankKey(c: { buyerRank: number | null; supplierRank: number | null }): [number, number] {
  const b = c.buyerRank;
  const s = c.supplierRank;
  if (b !== null && s !== null) return [0, b + s];
  if (b !== null) return [1, b];
  if (s !== null) return [1, s];
  return [2, 0];
}

/**
 * Who an admin can put in an open or replaced slot (scope 2.5). For a
 * supplier's slot: active buyers free in that slot, not already meeting the
 * supplier, eligible (`isEligible`: N/A, biztech opt-in, withdrawn). For a
 * buyer's slot, the same rules with the sides swapped. Best combined rank
 * first, blanks last, then the fewest appointments, then name.
 */
export async function swapCandidates(db: Db, input: SwapCandidatesInput): Promise<ActionResult<SwapCandidate[]>> {
  const run = await findRun(db, input.runId);
  if (!run) return fail("not_found", "That run no longer exists. Reload the schedule.");
  // Only the slot's own person's rankings matter: both directions of each pair with them.
  const focusId = "supplierId" in input ? input.supplierId : input.buyerId;
  const [roster, rows, rankingRows] = await Promise.all([
    loadPeople(db, run.eventId),
    db.select().from(appointments).where(eq(appointments.runId, run.id)),
    db
      .select()
      .from(rankings)
      .where(
        and(eq(rankings.eventId, run.eventId), or(eq(rankings.rankerId, focusId), eq(rankings.targetId, focusId))),
      ),
  ]);
  if (!roster) return fail("not_found", "That event no longer exists.");
  const index = buildRankingIndex(toEngineRankings(rankingRows));
  const eligibility: EligibilityContext = { index, settings: roster.event.settings };
  const n = roster.event.settings.mutualTopN;
  const counts = countsFor(rows);
  const inSlot = rows.filter((r) => r.slot === input.slot);
  const name = (id: string) => roster.names.get(id) ?? id;
  const pair = (buyerId: string, supplierId: string, candidateId: string) => {
    const buyerRank = index.buyerRank(buyerId, supplierId);
    const supplierRank = index.supplierRank(supplierId, buyerId);
    const count = counts.get(candidateId) ?? 0;
    return {
      buyerId,
      supplierId,
      name: name(candidateId),
      buyerRank,
      supplierRank,
      strength: matchStrength(buyerRank, supplierRank, n),
      count,
      countAfter: count + 1,
    };
  };

  const candidates: SwapCandidate[] = [];
  if ("supplierId" in input) {
    const supplier = roster.suppliers.find((s) => s.id === input.supplierId);
    if (!supplier) return fail("not_found", "That supplier is not on this event's roster.");
    const busy = new Set(inSlot.map((r) => r.buyerId));
    const paired = new Set(rows.filter((r) => r.supplierId === supplier.id).map((r) => r.buyerId));
    const engineSupplier = { id: supplier.id, type: supplier.type, withdrawn: supplier.status === "withdrawn" };
    for (const p of roster.participants) {
      if (p.status !== "active" || p.id === input.excludeBuyerId || busy.has(p.id) || paired.has(p.id)) continue;
      if (!isEligible({ id: p.id, biztechOptIn: p.biztechOptIn }, engineSupplier, eligibility)) continue;
      candidates.push({
        kind: "buyer",
        ...pair(p.id, supplier.id, p.id),
        organization: p.organization,
        title: p.title,
        biztechOptIn: p.biztechOptIn,
      });
    }
  } else {
    const buyer = roster.participants.find((p) => p.id === input.buyerId);
    if (!buyer) return fail("not_found", "That buyer is not on this event's roster.");
    if (buyer.status === "withdrawn") return fail("conflict", `${name(buyer.id)} has withdrawn.`);
    const busy = new Set(inSlot.map((r) => r.supplierId));
    const paired = new Set(rows.filter((r) => r.buyerId === buyer.id).map((r) => r.supplierId));
    const engineBuyer = { id: buyer.id, biztechOptIn: buyer.biztechOptIn };
    for (const s of roster.suppliers) {
      if (s.status !== "active" || busy.has(s.id) || paired.has(s.id)) continue;
      if (!isEligible(engineBuyer, { id: s.id, type: s.type, withdrawn: false }, eligibility)) continue;
      candidates.push({
        kind: "supplier",
        ...pair(buyer.id, s.id, s.id),
        supplierType: s.type,
        desk: s.deskNumber,
      });
    }
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
    .where(
      and(
        eq(auditEvents.eventId, run.eventId),
        eq(auditEvents.action, "appointment.undo"),
        eq(auditEvents.note, undoNote(row.id)),
      ),
    )
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
      { ...options, pinned: before.pinned },
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
