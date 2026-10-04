import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, type Event } from "@/db/schema";
import { fail, type ActionResult } from "@/lib/errors";

const FROZEN_STATUSES = new Set<Event["status"]>(["locked", "sent", "archived"]);

/**
 * A locked, sent, or archived event refuses every roster and import change.
 * Follow-up: replace with `assertEventEditable` from src/server/events/actions.ts
 * once the events module lands, so the rule lives in one place.
 */
export function assertEditable(event: Pick<Event, "status">): ActionResult<void> | null {
  if (!FROZEN_STATUSES.has(event.status)) return null;
  return fail("locked", `The event is ${event.status}. Unlock it before making changes.`);
}

export async function loadEvent(db: Db, eventId: string): Promise<Event | null> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return event ?? null;
}

/** Loads the event and checks it is editable in one step. */
export async function loadEditableEvent(
  db: Db,
  eventId: string,
): Promise<{ ok: true; event: Event } | { ok: false; error: ActionResult<never> }> {
  const event = await loadEvent(db, eventId);
  if (!event) return { ok: false, error: fail("not_found", "That event no longer exists.") };
  const frozen = assertEditable(event);
  if (frozen) return { ok: false, error: frozen as ActionResult<never> };
  return { ok: true, event };
}
