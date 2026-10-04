import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, type EventStatus } from "@/db/schema";
import { fail, type ActionResult } from "@/lib/errors";

/** Statuses where every mutation except unlock, exports, and email sends is refused. */
export const READ_ONLY_STATUSES: readonly EventStatus[] = ["locked", "sent", "archived"];

export function isEventEditable(event: { status: EventStatus }): boolean {
  return !READ_ONLY_STATUSES.includes(event.status);
}

/**
 * Returns a `locked` failure when the event is locked, sent, or archived, else null.
 * Call it in every action that changes event data:
 *
 *   const blocked = assertEventEditable(event);
 *   if (blocked) return blocked;
 */
export function assertEventEditable(event: { status: EventStatus }): ActionResult<never> | null {
  if (isEventEditable(event)) return null;
  const reason =
    event.status === "archived"
      ? "This event is archived and can't be changed."
      : "The schedule is locked. Unlock it to make changes.";
  return fail("locked", reason);
}

/** Returned with code `conflict` when the event's status moved between the read and the write. */
export const EVENT_CHANGED_MESSAGE = "The event changed while you were working. Reload and try again.";

/** Thrown inside a transaction to roll it back when the event is no longer editable. */
export class EventChangedError extends Error {
  constructor() {
    super(EVENT_CHANGED_MESSAGE);
    this.name = "EventChangedError";
  }
}

/**
 * The compare-and-set half of an editability check. Call it first inside the
 * transaction of any write that depends on the event being editable: it locks
 * the event row (`FOR UPDATE`) only while the status is still editable, so a
 * concurrent lock, archive, or status change waits for this transaction or
 * makes it fail. Throws `EventChangedError` when the status moved.
 */
export async function claimEditableEvent(tx: Db, eventId: string): Promise<void> {
  const [row] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), notInArray(events.status, [...READ_ONLY_STATUSES])))
    .for("update");
  if (!row) throw new EventChangedError();
}

/** Turns an `EventChangedError` thrown by a transaction into the conflict result. */
export function eventChangedResult(error: unknown): ActionResult<never> | null {
  return error instanceof EventChangedError ? fail("conflict", EVENT_CHANGED_MESSAGE) : null;
}
