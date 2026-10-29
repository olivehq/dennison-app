import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, type Event, type EventStatus } from "@/db/schema";
import { EVENT_GATES, eventAllows, type EventGate } from "@/lib/event-gates";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { getEvent } from "./queries";

export function isEventEditable(event: { status: EventStatus }): boolean {
  return eventAllows("edit", event.status);
}

export const ARCHIVED_MESSAGE = "This event is archived and can't be changed.";

/** Early refusal before costly or external work; writes still need an event transaction. */
export function assertEventEditable(event: { status: EventStatus }): ActionResult<never> | null {
  if (isEventEditable(event)) return null;
  const reason = event.status === "archived" ? ARCHIVED_MESSAGE : "The schedule is locked. Unlock it on the Schedule page to make changes.";
  return fail("locked", reason);
}

/** Loads and checks the event before import storage work outside the transaction. */
export async function loadEditableEvent(
  db: Db,
  eventId: string,
): Promise<{ ok: true; event: Event } | { ok: false; error: ActionResult<never> }> {
  const event = await getEvent(eventId, db);
  if (!event) return { ok: false, error: fail("not_found", "That event no longer exists.") };
  const blocked = assertEventEditable(event);
  if (blocked) return { ok: false, error: blocked };
  return { ok: true, event };
}

/** Returned with code `conflict` when the event's status moved between the read and the write. */
export const EVENT_CHANGED_MESSAGE = "The event changed while you were working. Reload and try again.";

/** Thrown inside a transaction to roll it back when the event is no longer in a status the write needs. */
export class EventChangedError extends Error {
  constructor() {
    super(EVENT_CHANGED_MESSAGE);
    this.name = "EventChangedError";
  }
}

/** Thrown inside `inEventTransaction` to roll back and return `result` (a check that failed under the lock). */
export class Refused extends Error {
  constructor(readonly result: ActionResult<never>) {
    super(result.ok ? "" : result.error.message);
  }
}

/**
 * Locks the event row (`FOR UPDATE`) only while its status passes `gate`, so a concurrent lock,
 * archive, or status change waits for this transaction or makes it fail.
 * Returns the event as it is under the lock, or null when it is gone or its
 * status moved.
 */
export async function claimEvent(tx: Db, eventId: string, gate: EventGate): Promise<Event | null> {
  const [row] = await tx
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), inArray(events.status, [...EVENT_GATES[gate]])))
    .for("update");
  return row ?? null;
}

/**
 * Runs `work` in a transaction that first claims the event row against
 * `gate` (D85) and hands it the event as it is under the lock. A failed claim
 * re-reads the event for a precise refusal. An `EventChangedError` becomes a conflict;
 * a `Refused` from `work` becomes its result. Other errors are rethrown.
 */
export async function inEventTransaction<T>(
  db: Db,
  eventId: string,
  gate: EventGate,
  work: (tx: Db, event: Event) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return ok(
      await db.transaction(async (tx) => {
        const event = await claimEvent(tx, eventId, gate);
        if (!event) {
          const current = await getEvent(eventId, tx);
          if (!current) throw new Refused(fail("not_found", "That event no longer exists."));
          if (current.status === "archived") throw new Refused(fail("locked", ARCHIVED_MESSAGE));
          if (gate === "edit") {
            const blocked = assertEventEditable(current);
            if (blocked) throw new Refused(blocked);
          }
          if (gate === "locked") throw new Refused(fail("validation", "The schedule is not locked."));
          if (gate === "draft") throw new Refused(fail("conflict", "Only draft events can be deleted. Archive this one instead."));
          throw new EventChangedError();
        }
        return work(tx, event);
      }),
    );
  } catch (error) {
    if (error instanceof Refused) return error.result;
    if (error instanceof EventChangedError) return fail("conflict", EVENT_CHANGED_MESSAGE);
    throw error;
  }
}
