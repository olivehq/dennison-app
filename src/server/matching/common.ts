import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, type Event, type EventStatus } from "@/db/schema";
import { fail, type ActionResult } from "@/lib/errors";

/**
 * Helpers shared by the matching, schedule, and tokens modules.
 *
 * Follow-up: `assertEditable` duplicates the status check the events module
 * owns. Unify once both land.
 */

const LOCKED_STATUSES: ReadonlySet<EventStatus> = new Set(["locked", "sent", "archived"]);

/**
 * A locked event rejects every mutation except unlock, exports, and sends
 * (AGENTS.md invariants). Returns the failure to return, or null when edits
 * are allowed.
 */
export function assertEditable(event: Pick<Event, "status">): ActionResult<never> | null {
  if (LOCKED_STATUSES.has(event.status)) {
    return fail("locked", "The schedule is locked. Unlock it to make changes.");
  }
  return null;
}

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
