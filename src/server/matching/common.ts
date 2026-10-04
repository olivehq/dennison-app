import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, type Event } from "@/db/schema";

/** Helpers shared by the matching, schedule, and tokens modules. */

/**
 * @deprecated Import `assertEventEditable` from `@/server/events/editable` (D27).
 * This alias only keeps `src/server/schedule` compiling until it switches its
 * imports; it is the same function, not a copy.
 */
export { assertEventEditable as assertEditable } from "@/server/events/editable";

export async function loadEvent(db: Db, eventId: string): Promise<Event | null> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return event ?? null;
}

export type BuyerNameSource = {
  firstName: string;
  lastName: string;
  organization: string | null;
  title: string | null;
  displayName?: string | null;
};

/**
 * How a buyer is shown everywhere: an explicit display name if an admin set
 * one, else "Organization - Title" when both exist, else first and last name.
 */
export function buyerDisplayName(buyer: BuyerNameSource): string {
  if (buyer.displayName && buyer.displayName.trim() !== "") return buyer.displayName.trim();
  if (buyer.organization && buyer.title) return `${buyer.organization} - ${buyer.title}`;
  return `${buyer.firstName} ${buyer.lastName}`.trim();
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Replaces every database id in an engine warning with the person's display name. */
export function nameWarning(warning: string, names: ReadonlyMap<string, string>): string {
  return warning.replace(UUID_PATTERN, (id) => names.get(id.toLowerCase()) ?? id);
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}
