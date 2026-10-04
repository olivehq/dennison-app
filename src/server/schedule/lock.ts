import { and, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import { appointments, participants, suppliers, type Supplier } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { compareNames } from "@/lib/names";
import { recordAudit } from "@/server/audit/audit";
import {
  assertEventEditable,
  claimEditableEvent,
  EVENT_CHANGED_MESSAGE,
  EventChangedError,
} from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { advanceStatus, hasSendInProgress, SEND_IN_PROGRESS_MESSAGE } from "@/server/events/status";
import { findActiveRun } from "@/server/matching/runs";
import { issueTokensForEvent } from "@/server/tokens/tokens";

/**
 * Lock, unlock, and desk numbers (scope 2.5, D17). Locking freezes the
 * schedule, assigns desks, and issues participant links (scope 2.6).
 */

export type DeskAssignment = {
  supplierId: string;
  name: string;
  desk: number | null;
  override: boolean;
};

/**
 * D17: desks go alphabetically by supplier name. A supplier with
 * `desk_override` keeps its number and that number is skipped for the rest.
 * Withdrawn suppliers get no desk unless they hold an override.
 */
export function planDesks(rows: Supplier[]): DeskAssignment[] {
  const sorted = [...rows].sort((a, b) => compareNames(a.name, b.name));
  const taken = new Set<number>();
  for (const s of sorted) {
    if (s.deskOverride && s.deskNumber !== null) taken.add(s.deskNumber);
  }
  let next = 1;
  return sorted.map((s) => {
    if (s.deskOverride) {
      return { supplierId: s.id, name: s.name, desk: s.deskNumber, override: true };
    }
    if (s.status === "withdrawn") {
      return { supplierId: s.id, name: s.name, desk: null, override: false };
    }
    while (taken.has(next)) next++;
    const desk = next++;
    return { supplierId: s.id, name: s.name, desk, override: false };
  });
}

async function applyDesks(db: Db, eventId: string): Promise<{ before: DeskAssignment[]; after: DeskAssignment[] }> {
  const rows = await db.select().from(suppliers).where(eq(suppliers.eventId, eventId));
  const before = rows
    .map((s) => ({ supplierId: s.id, name: s.name, desk: s.deskNumber, override: s.deskOverride }))
    .sort((a, b) => compareNames(a.name, b.name));
  const after = planDesks(rows);
  for (const plan of after) {
    const current = rows.find((s) => s.id === plan.supplierId);
    if (current && current.deskNumber === plan.desk) continue;
    await db.update(suppliers).set({ deskNumber: plan.desk }).where(eq(suppliers.id, plan.supplierId));
  }
  return { before, after };
}

export type LockResult = {
  eventId: string;
  desks: DeskAssignment[];
  tokensIssued: number;
};

/** Appointments of the run where the buyer or the supplier has withdrawn since it was built. */
export async function countWithdrawnAppointments(db: Db, runId: string): Promise<number> {
  const buyer = alias(participants, "buyer");
  const supplier = alias(suppliers, "supplier");
  const rows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .innerJoin(buyer, eq(buyer.id, appointments.buyerId))
    .innerJoin(supplier, eq(supplier.id, appointments.supplierId))
    .where(and(eq(appointments.runId, runId), or(eq(buyer.status, "withdrawn"), eq(supplier.status, "withdrawn"))));
  return rows.length;
}

function withdrawnLockMessage(n: number): string {
  return n === 1
    ? "1 appointment involves someone who withdrew. Re-run matching keeping existing appointments, or remove it, before locking."
    : `${n} appointments involve someone who withdrew. Re-run matching keeping existing appointments, or remove them, before locking.`;
}

/** Runs `work` in a transaction, turning `EventChangedError` into the conflict result. */
async function inTransaction<T>(db: Db, work: (tx: Db) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await db.transaction(work);
  } catch (error) {
    if (error instanceof EventChangedError) return fail("conflict", EVENT_CHANGED_MESSAGE);
    throw error;
  }
}

class Refused extends Error {
  constructor(readonly result: ActionResult<never>) {
    super(result.ok ? "" : result.error.message);
  }
}

/**
 * Freezes the schedule: desks (D17), participant links (D14), status `locked`.
 * The status change is a compare-and-set on the status read here and runs
 * first in the transaction, so it holds the event row while desks and links
 * are written, and a concurrent edit, lock, or archive makes this a conflict.
 * Refused while any appointment involves a withdrawn person.
 */
export async function lockSchedule(
  db: Db,
  input: { eventId: string; adminId: string },
): Promise<ActionResult<LockResult>> {
  const event = await getEvent(input.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return fail("conflict", "The schedule is already locked.");
  const active = await findActiveRun(db, event.id);
  if (!active) return fail("validation", "Run matching and activate a run before locking.");

  try {
    return await inTransaction(db, async (tx) => {
      if (!(await advanceStatus(tx, event.id, event.status, "locked"))) throw new EventChangedError();
      // Read again under the row lock: the active run or a withdrawal may have changed since.
      const current = await findActiveRun(tx, event.id);
      if (current?.id !== active.id) throw new EventChangedError();
      const withdrawn = await countWithdrawnAppointments(tx, active.id);
      if (withdrawn > 0) throw new Refused(fail("conflict", withdrawnLockMessage(withdrawn)));
      const { after: desks } = await applyDesks(tx, event.id);
      const issued = await issueTokensForEvent(tx, event.id);
      // Throwing rolls the desk changes back; the event was loaded a moment ago so this cannot happen.
      if (!issued.ok) throw new Error(issued.error.message);
      await recordAudit(tx, {
        eventId: event.id,
        adminId: input.adminId,
        action: "schedule.lock",
        entityType: "event",
        entityId: event.id,
        before: { status: event.status },
        after: { status: "locked", runId: active.id, desks, tokensIssued: issued.data.length },
      });
      return ok({ eventId: event.id, desks, tokensIssued: issued.data.length });
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

/**
 * Reopens the editor. Needs a reason, which goes in the activity log. A
 * compare-and-set from the status read. Refused while a campaign is sending,
 * so the emails in flight match the schedule they describe.
 */
export async function unlockSchedule(
  db: Db,
  input: { eventId: string; adminId: string; reason: string },
): Promise<ActionResult<{ eventId: string }>> {
  const reason = input.reason.trim();
  if (reason === "") return fail("validation", "Say why you are unlocking.", { reason: ["Required."] });
  const event = await getEvent(input.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status !== "locked" && event.status !== "sent") {
    return fail("validation", "The schedule is not locked.");
  }
  try {
    return await inTransaction(db, async (tx) => {
      if (!(await advanceStatus(tx, event.id, event.status, "matched"))) throw new EventChangedError();
      // Checked under the row lock the status change took; throwing rolls it back.
      if (await hasSendInProgress(tx, event.id)) throw new Refused(fail("conflict", SEND_IN_PROGRESS_MESSAGE));
      await recordAudit(tx, {
        eventId: event.id,
        adminId: input.adminId,
        action: "schedule.unlock",
        entityType: "event",
        entityId: event.id,
        before: { status: event.status },
        after: { status: "matched" },
        note: reason,
      });
      return ok({ eventId: event.id });
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

/** Re-runs the D17 desk rule while unlocked. Overrides are kept. */
export async function reassignDesks(
  db: Db,
  input: { eventId: string; adminId: string },
): Promise<ActionResult<{ eventId: string; desks: DeskAssignment[] }>> {
  const event = await getEvent(input.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return locked;
  return inTransaction(db, async (tx) => {
    await claimEditableEvent(tx, event.id);
    const { before, after } = await applyDesks(tx, event.id);
    await recordAudit(tx, {
      eventId: event.id,
      adminId: input.adminId,
      action: "schedule.reassign_desks",
      entityType: "event",
      entityId: event.id,
      before: { desks: before },
      after: { desks: after },
    });
    return ok({ eventId: event.id, desks: after });
  });
}
