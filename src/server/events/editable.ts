import type { EventStatus } from "@/db/schema";
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
