import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, type EventStatus } from "@/db/schema";

/**
 * Moves the event to `to` only when its current status is `from` (one status
 * or several). A compare-and-set in one UPDATE, so it is safe inside a
 * transaction and never moves an event backwards from a later step.
 * Returns true when the status changed.
 *
 *   await advanceStatus(tx, eventId, "draft", "imported");
 */
export async function advanceStatus(
  db: Db,
  eventId: string,
  from: EventStatus | readonly EventStatus[],
  to: EventStatus,
): Promise<boolean> {
  const allowed = typeof from === "string" ? [from] : [...from];
  if (allowed.length === 0) return false;
  const rows = await db
    .update(events)
    .set({ status: to })
    .where(and(eq(events.id, eventId), inArray(events.status, allowed)))
    .returning({ id: events.id });
  return rows.length > 0;
}
