/**
 * File names for the per-person schedule CSVs (output spec, "Filename
 * Requirements"): `/` and `\` become `_`, `:` becomes `-`, commas go, and the
 * whole name including `.csv` is at most 80 characters. Characters Windows
 * refuses in file names (`* ? " < > |`) also become `_`, so the ZIP extracts
 * anywhere.
 */

export const MAX_FILENAME_LENGTH = 80;
const EXTENSION = ".csv";

function sanitise(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "_")
      .replace(/:/g, "-")
      .replace(/,/g, "")
      .replace(/[*?"<>|]/g, "_")
      // Control characters never belong in a file name.
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Cuts the stem so stem + suffix fits, and drops trailing spaces and dots left by the cut. */
function fit(stem: string, suffix: string): string {
  const room = MAX_FILENAME_LENGTH - suffix.length;
  return stem.slice(0, Math.max(0, room)).replace(/[\s.]+$/, "") + suffix;
}

/** `scheduleFilename("Buyer_Schedule_", "Acme: Events, West")` -> `Buyer_Schedule_Acme- Events West.csv`. */
export function scheduleFilename(prefix: string, name: string): string {
  const cleaned = sanitise(name) || "Unnamed";
  return fit(`${prefix}${cleaned}`, EXTENSION);
}

/**
 * De-duplicates names that collide after truncation by appending `_2`, `_3`,
 * before the extension, still within 80 characters. Comparison ignores case
 * because macOS and Windows file systems do.
 */
export function uniqueFilenames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    if (taken.has(candidate.toLowerCase())) {
      const stem = name.endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length) : name;
      for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
        candidate = fit(stem, `_${n}${EXTENSION}`);
      }
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
