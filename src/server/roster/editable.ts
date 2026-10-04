import type { Db } from "@/db/client";
import type { Event } from "@/db/schema";
import { fail, type ActionResult } from "@/lib/errors";
import { assertEventEditable } from "@/server/events/editable";
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
