import { getDb, type Db } from "@/db/client";
import type { ImportKind, ImportState } from "@/lib/schemas/import";
import { getImportStatusByKind } from "@/server/imports/queries";
import { getMatchingReadiness, type MatchingCounts } from "./queries";

/**
 * Whether matching may run (scope 2.3: the ranking files are green). Ready
 * needs at least one active buyer and supplier, at least one buyer-side and
 * one supplier-side ranking row, and no import left half done: the latest
 * import of each kind must not be waiting for name mapping, fixes, or Apply,
 * and must not have failed validation. Ignored imports don't count: the
 * latest file of a kind that isn't ignored is the one checked.
 * Rankings loaded without an import (the seed) are fine.
 */
export type MatchingReadiness = {
  ready: boolean;
  /** Sentences an admin can act on, in the order to fix them. Empty when ready. */
  reasons: string[];
  counts: MatchingCounts;
};

const KIND_LABEL: Record<ImportKind, string> = {
  participants: "participants",
  suppliers: "suppliers",
  buyer_biztech_rankings: "buyer biztech rankings",
  buyer_hotel_rankings: "buyer hotel rankings",
  supplier_rankings: "supplier rankings",
};

/** The import kinds that fill each count, so a pending file of that kind explains a zero. */
const COUNT_KINDS: { count: keyof MatchingCounts; kinds: ImportKind[]; reason: string }[] = [
  { count: "buyers", kinds: ["participants"], reason: "Add at least one active buyer." },
  { count: "suppliers", kinds: ["suppliers"], reason: "Add at least one active supplier." },
  { count: "buyerRankings", kinds: ["buyer_biztech_rankings", "buyer_hotel_rankings"], reason: "Load the buyer rankings." },
  { count: "supplierRankings", kinds: ["supplier_rankings"], reason: "Load the supplier rankings." },
];

function fileReason(label: string, state: ImportState): string | null {
  if (state === "needs_mapping") return `The ${label} file has unknown names. Map them, then apply the file.`;
  if (state === "needs_fixes") return `The ${label} file has errors. Fix it and upload it again.`;
  if (state === "ready") return `The ${label} file is checked but not applied. Apply it.`;
  // Even with older rankings in place: the newest file is what staff meant to use.
  if (state === "failed") return `The latest ${label} upload failed validation. Fix or delete it.`;
  return null;
}

/**
 * One reason per cause: a zero count whose kind has a file waiting says only
 * what to do with that file, not also "Load the ...".
 */
export async function matchingReadiness(db: Db, eventId: string): Promise<MatchingReadiness> {
  const [counts, latest] = await Promise.all([getMatchingReadiness(eventId, db), getImportStatusByKind(eventId, db)]);
  const fileReasons = new Map<ImportKind, string>();
  for (const [kind, summary] of Object.entries(latest) as [ImportKind, (typeof latest)[ImportKind]][]) {
    const reason = summary ? fileReason(KIND_LABEL[kind], summary.state) : null;
    if (reason) fileReasons.set(kind, reason);
  }
  const reasons: string[] = [];
  for (const { count, kinds, reason } of COUNT_KINDS) {
    if (counts[count] === 0 && !kinds.some((kind) => fileReasons.has(kind))) reasons.push(reason);
  }
  reasons.push(...fileReasons.values());
  return { ready: reasons.length === 0, reasons, counts };
}

/** `matchingReadiness` for pages, in the queries' argument order. */
export function getMatchingGate(eventId: string, db: Db = getDb()): Promise<MatchingReadiness> {
  return matchingReadiness(db, eventId);
}
