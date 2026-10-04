import type { Db } from "@/db/client";
import type { Event } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { assertEventEditable, claimEditableEvent, eventChangedResult } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";

/** Loads the event and checks it is editable (D27) in one step. Used by roster and import writes. */
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

/** Thrown inside `inEditableTransaction` to roll back and return `result` (a check that failed under the lock). */
export class Refused extends Error {
  constructor(readonly result: ActionResult<never>) {
    super(result.ok ? "" : result.error.message);
  }
}

/**
 * Runs `work` in a transaction that first claims the event as editable
 * (`claimEditableEvent`, D85), so a lock or archive between the caller's
 * check and this write makes it the event-changed conflict, and roster
 * writes of one event run one at a time. `Refused` becomes its result.
 */
export async function inEditableTransaction<T>(
  db: Db,
  eventId: string,
  work: (tx: Db) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return ok(
      await db.transaction(async (tx) => {
        await claimEditableEvent(tx, eventId);
        return work(tx);
      }),
    );
  } catch (error) {
    if (error instanceof Refused) return error.result;
    const changed = eventChangedResult(error);
    if (changed) return changed;
    throw error;
  }
}
