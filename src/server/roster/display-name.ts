/**
 * The one place a buyer's name is built (D66 sorts it, this formats it).
 * Matching, schedule, tokens, email, audit, and imports all call these.
 */
export type DisplayNameSource = {
  firstName: string;
  lastName: string;
  organization?: string | null;
  title?: string | null;
  displayName?: string | null;
};

export function fullNameFor(person: Pick<DisplayNameSource, "firstName" | "lastName">): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/** An explicit display name wins (trimmed, blank ignored), then "Organization - Title" as in 2025, then the full name. */
export function displayNameFor(person: DisplayNameSource): string {
  const explicit = person.displayName?.trim();
  if (explicit) return explicit;
  if (person.organization && person.title) return `${person.organization} - ${person.title}`;
  return fullNameFor(person);
}
