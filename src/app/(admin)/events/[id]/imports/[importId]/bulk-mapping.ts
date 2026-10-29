import { BULK_MAPPING_MIN_SCORE, type UnknownName } from "@/lib/schemas/import";

/**
 * What "Save all suggested" maps: names whose top suggestion is near-certain
 * (at least `BULK_MAPPING_MIN_SCORE`, not tied with the next one, never an
 * ambiguous name). Everything else is skipped for the admin to map one at a
 * time.
 */
export function bulkMappings(names: UnknownName[]): { take: UnknownName[]; skipped: number } {
  const take = names.filter((name) => {
    const [top, next] = name.suggestions;
    return !name.ambiguous && top !== undefined && top.score >= BULK_MAPPING_MIN_SCORE && (next?.score ?? 0) < top.score;
  });
  return { take, skipped: names.length - take.length };
}
