import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { emailCampaigns, events, type EventStatus } from "@/db/schema";

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

/** Returned by unlock and archive while a campaign of the event is mid-send. */
export const SEND_IN_PROGRESS_MESSAGE = "An email send is in progress. Wait for it to finish.";

/**
 * True while any email campaign of the event has status `sending`. Unlock and
 * archive call it inside their transaction, after taking the event row, so a
 * send that started against the locked schedule finishes against it.
 */
export async function hasSendInProgress(db: Db, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: emailCampaigns.id })
    .from(emailCampaigns)
    .where(and(eq(emailCampaigns.eventId, eventId), eq(emailCampaigns.status, "sending")))
    .limit(1);
  return row !== undefined;
}
