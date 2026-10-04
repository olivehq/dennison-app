/** Shapes the roster pages pass from the server page to their client tables. */

export type LinkState = "active" | "revoked" | "expired";

/** The newest token of one contact, or null when no link was ever issued. */
export type LinkInfo = { tokenId: string; state: LinkState } | null;

/**
 * "Changed since last email" (D13): `changed` when the schedule differs from
 * the one in the person's last email, `current` when it matches, null before
 * they were ever emailed.
 */
export type EmailChange = "changed" | "current" | null;

/** Worst of a supplier's contacts: changed beats current beats never emailed. */
export function combineEmailChange(...states: EmailChange[]): EmailChange {
  if (states.includes("changed")) return "changed";
  if (states.includes("current")) return "current";
  return null;
}

/** Appointment health against the event's targets. `none` means there is no active run. */
export type Health = "none" | "low" | "ok" | "high";

export type StatusFilter = "active" | "withdrawn" | "all";

export function parseStatusFilter(value: string | string[] | undefined): StatusFilter {
  return value === "withdrawn" || value === "all" ? value : "active";
}

export type BiztechFilter = "all" | "in" | "out";

export function parseBiztechFilter(value: string | string[] | undefined): BiztechFilter {
  return value === "in" || value === "out" ? value : "all";
}

export type TypeFilter = "all" | "business" | "hotel";

export function parseTypeFilter(value: string | string[] | undefined): TypeFilter {
  return value === "business" || value === "hotel" ? value : "all";
}

/** Below `min` is low, above `max` is high, anything when no run is active is none. */
export function healthFor(count: number, min: number, max: number, hasRun: boolean): Health {
  if (!hasRun) return "none";
  if (count < min) return "low";
  if (count > max) return "high";
  return "ok";
}
