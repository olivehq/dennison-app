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

/** An explicit display name wins, then "Organization - Title" as in 2025, then the full name. */
export function displayNameFor(person: DisplayNameSource): string {
  if (person.displayName) return person.displayName;
  if (person.organization && person.title) return `${person.organization} - ${person.title}`;
  return fullNameFor(person);
}
