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

/**
 * The query string (with its "?", or "" when empty) after setting `key` to
 * `value`. The fallback value is the default view, so it leaves the key out.
 */
export function queryWithParam(search: string, key: string, value: string, fallback: string): string {
  const params = new URLSearchParams(search);
  if (value === fallback) params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The roster search text from `?q=`. A repeated key is ignored. */
export function parseSearchQuery(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export type StatusFilter = "active" | "withdrawn" | "all";

export function parseStatusFilter(value: string | string[] | undefined): StatusFilter {
  return value === "withdrawn" || value === "all" ? value : "active";
}

export type BiztechFilter = "all" | "in" | "out";

export function parseBiztechFilter(value: string | string[] | undefined): BiztechFilter {
  return value === "in" || value === "out" ? value : "all";
}

/** "Any link", or the state of a contact's newest link. `none` means no link was ever issued. */
export type LinkFilter = "all" | LinkState | "none";

export function parseLinkFilter(value: string | string[] | undefined): LinkFilter {
  return value === "active" || value === "revoked" || value === "expired" || value === "none" ? value : "all";
}

/**
 * A row matches when any of its contacts' links is in the state. A supplier
 * with no contact email holds no link at all, so it counts as "none".
 */
export function matchesLinkFilter(filter: LinkFilter, links: LinkInfo[]): boolean {
  if (filter === "all") return true;
  if (links.length === 0) return filter === "none";
  return links.some((link) => (link?.state ?? "none") === filter);
}

export type TypeFilter = "all" | "business" | "hotel";

export function parseTypeFilter(value: string | string[] | undefined): TypeFilter {
  return value === "business" || value === "hotel" ? value : "all";
}

/**
 * Below `min` is low, above `max` is high, anything when no run is active is none.
 * A withdrawn person is never flagged (D153): the schedule leaves them out of its counts too.
 */
export function healthFor(count: number, min: number, max: number, hasRun: boolean, withdrawn = false): Health {
  if (!hasRun) return "none";
  if (withdrawn) return "ok";
  if (count < min) return "low";
  if (count > max) return "high";
  return "ok";
}
