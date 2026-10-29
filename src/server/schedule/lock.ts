import { and, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import { appointments, participants, suppliers, type Supplier } from "@/db/schema";
import { fail, type ActionResult } from "@/lib/errors";
import { compareNames } from "@/lib/names";
import { recordAudit } from "@/server/audit/audit";
import {
  EventChangedError,
  inEventTransaction,
  Refused,
} from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { advanceStatus, hasSendInProgress, SEND_IN_PROGRESS_MESSAGE } from "@/server/events/status";
import { findActiveRun } from "@/server/matching/runs";
import { issueTokensForEvent, linksForContacts, listContacts } from "@/server/tokens/tokens";

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
 * D17: desks go alphabetically by supplier name. An active supplier with
 * `desk_override` keeps its number and that number is skipped for the rest.
 * Withdrawn suppliers get no desk, an override included: the desk and the
 * override are cleared, so the number is free for an active supplier.
 */
export function planDesks(rows: Supplier[]): DeskAssignment[] {
  const sorted = [...rows].sort((a, b) => compareNames(a.name, b.name));
  const taken = new Set<number>();
  for (const s of sorted) {
    if (s.status !== "withdrawn" && s.deskOverride && s.deskNumber !== null) taken.add(s.deskNumber);
  }
  let next = 1;
  return sorted.map((s) => {
    if (s.status === "withdrawn") {
      return { supplierId: s.id, name: s.name, desk: null, override: false };
    }
    if (s.deskOverride) {
      return { supplierId: s.id, name: s.name, desk: s.deskNumber, override: true };
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
    if (current && current.deskNumber === plan.desk && current.deskOverride === plan.override) continue;
    await db
      .update(suppliers)
      .set({ deskNumber: plan.desk, deskOverride: plan.override })
      .where(eq(suppliers.id, plan.supplierId));
  }
  return { before, after };
}

export type LockResult = {
  eventId: string;
  desks: DeskAssignment[];
  tokensIssued: number;
  /** Current contacts whose link was already live and stayed (unlock keeps them), so a second lock issues none. */
  tokensKept: number;
  /** Current contacts whose newest link was revoked: lock doesn't replace it; Regenerate on the roster does. */
  linksRevoked: number;
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

/**
 * Freezes the schedule: desks (D17), participant links (D14), status `locked`.
 * The transaction claims the event row first and the status change is a
 * compare-and-set on the status read here, so the row is held while desks
 * and links are written. Concurrent locks and archives return their refusal;
 * other status or active-run changes return conflict. Refused while any appointment involves a withdrawn person, and
 * with the archived message on an archived event.
 */
export async function lockSchedule(
  db: Db,
  input: { eventId: string; adminId: string },
): Promise<ActionResult<LockResult>> {
  const event = await getEvent(input.eventId, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  const active = await findActiveRun(db, event.id);

  return inEventTransaction(db, event.id, "edit", async (tx) => {
    if (!active) throw new Refused(fail("validation", "Run matching and activate a run before locking."));
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
    // Counted per current contact (D180), not per token: a withdrawn person's live
    // token is not a kept link, and a revoked newest link means that contact has none.
    const contactLinks = await linksForContacts(tx, event.id, await listContacts(tx, event.id), { issueMissing: false });
    if (!contactLinks.ok) throw new Error(contactLinks.error.message);
    await recordAudit(tx, {
      eventId: event.id,
      adminId: input.adminId,
      action: "schedule.lock",
      entityType: "event",
      entityId: event.id,
      before: { status: event.status },
      after: { status: "locked", runId: active.id, desks, tokensIssued: issued.data.length },
    });
    return {
      eventId: event.id,
      desks,
      tokensIssued: issued.data.length,
      tokensKept: Math.max(0, contactLinks.data.links.size - issued.data.length),
      linksRevoked: contactLinks.data.revoked.size,
    };
  });
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
  return inEventTransaction(db, event.id, "locked", async (tx) => {
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
    return { eventId: event.id };
  });
}

/** Re-runs the D17 desk rule while unlocked. Overrides are kept. */
export async function reassignDesks(
  db: Db,
  input: { eventId: string; adminId: string },
): Promise<ActionResult<{ eventId: string; desks: DeskAssignment[] }>> {
  return inEventTransaction(db, input.eventId, "edit", async (tx, event) => {
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
    return { eventId: event.id, desks: after };
  });
}
