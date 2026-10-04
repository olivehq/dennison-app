import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, suppliers, type Supplier } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit";
import { compareNames } from "@/lib/names";
import { assertEventEditable } from "@/server/events/editable";
import { loadEvent } from "@/server/matching/common";
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

/** Freezes the schedule: desks (D17), participant links (D14), status `locked`. */
export async function lockSchedule(
  db: Db,
  input: { eventId: string; adminId: string },
): Promise<ActionResult<LockResult>> {
  const event = await loadEvent(db, input.eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return fail("conflict", "The schedule is already locked.");
  const active = await findActiveRun(db, event.id);
  if (!active) return fail("validation", "Run matching and activate a run before locking.");

  return db.transaction(async (tx) => {
    const { after: desks } = await applyDesks(tx, event.id);
    const issued = await issueTokensForEvent(tx, event.id);
    // Throwing rolls the desk changes back; the event was loaded a moment ago so this cannot happen.
    if (!issued.ok) throw new Error(issued.error.message);
    await tx.update(events).set({ status: "locked" }).where(eq(events.id, event.id));
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
}

/** Reopens the editor. Needs a reason, which goes in the activity log. */
export async function unlockSchedule(
  db: Db,
  input: { eventId: string; adminId: string; reason: string },
): Promise<ActionResult<{ eventId: string }>> {
  const reason = input.reason.trim();
  if (reason === "") return fail("validation", "Say why you are unlocking.", { reason: ["Required."] });
  const event = await loadEvent(db, input.eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status !== "locked" && event.status !== "sent") {
    return fail("validation", "The schedule is not locked.");
  }
  await db.transaction(async (tx) => {
    await tx.update(events).set({ status: "matched" }).where(eq(events.id, event.id));
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
  });
  return ok({ eventId: event.id });
}

/** Re-runs the D17 desk rule while unlocked. Overrides are kept. */
export async function reassignDesks(
  db: Db,
  input: { eventId: string; adminId: string },
): Promise<ActionResult<{ eventId: string; desks: DeskAssignment[] }>> {
  const event = await loadEvent(db, input.eventId);
  if (!event) return fail("not_found", "That event no longer exists.");
  const locked = assertEventEditable(event);
  if (locked) return locked;
  const desks = await db.transaction(async (tx) => {
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
    return after;
  });
  return ok({ eventId: event.id, desks });
}
