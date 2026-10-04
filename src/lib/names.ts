const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * The one order for names shown in a list or numbered by position (desks,
 * rosters, exports): locale-aware, case- and accent-insensitive, numbers by
 * value ("Hall 2" before "Hall 10"). Names that only differ in case or accents
 * fall back to a plain code-unit compare so the order is still total.
 */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
