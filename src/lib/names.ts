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

/**
 * Up to two letters for an avatar: first and last word of the name, or the
 * start of the email when the name is blank. "Demo Admin" reads "DA".
 */
export function initials(name: string, email = ""): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  const text = letters.map((w) => Array.from(w)[0]).join("") || Array.from(email.trim())[0] || "?";
  return text.toLocaleUpperCase("en");
}
