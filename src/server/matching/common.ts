/** Helpers shared by the matching, schedule, and tokens modules. */

/**
 * True for a Postgres unique violation (23505). Drizzle wraps driver errors,
 * so the cause chain is walked; works for postgres.js and PGlite.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    if (/duplicate key value violates unique constraint/i.test(current.message)) return true;
  }
  return false;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Replaces every database id in an engine warning with the person's display name. */
export function nameWarning(warning: string, names: ReadonlyMap<string, string>): string {
  return warning.replace(UUID_PATTERN, (id) => names.get(id.toLowerCase()) ?? id);
}
