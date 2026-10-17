import { compareNames } from "@/lib/names";
import type { EventStatus } from "@/lib/schemas/event";
import { isoDateInTimezone } from "@/lib/time";

type OrderableEvent = { name: string; eventDate: string; timezone: string; status: EventStatus };

/** 0 upcoming, 1 past but still open, 2 archived. "Today" is the show date in the event's timezone. */
function bucket(event: OrderableEvent, now: Date): number {
  if (event.status === "archived") return 2;
  return event.eventDate >= isoDateInTimezone(now, event.timezone) ? 0 : 1;
}

/**
 * The order the events list and the sidebar's recent events use: upcoming
 * shows soonest first, then past shows that aren't archived, most recent
 * first, then archived ones, most recent first. Same date sorts by name.
 */
export function orderEvents<T extends OrderableEvent>(events: readonly T[], now: Date = new Date()): T[] {
  return events
    .map((event) => ({ event, bucket: bucket(event, now) }))
    .sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.event.eventDate !== b.event.eventDate) {
        const soonestFirst = a.event.eventDate < b.event.eventDate ? -1 : 1;
        return a.bucket === 0 ? soonestFirst : -soonestFirst;
      }
      return compareNames(a.event.name, b.event.name);
    })
    .map(({ event }) => event);
}
