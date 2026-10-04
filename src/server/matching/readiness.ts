import { getDb, type Db } from "@/db/client";
import type { ImportKind } from "@/lib/schemas/import";
import { getImportStatusByKind } from "@/server/imports/queries";
import { getMatchingReadiness, type MatchingCounts } from "./queries";

/**
 * Whether matching may run (scope 2.3: the ranking files are green). Ready
 * needs at least one active buyer and supplier, at least one buyer-side and
 * one supplier-side ranking row, and no import left half done: the latest
 * import of each kind must not be waiting for name mapping, fixes, or Apply.
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

export async function matchingReadiness(db: Db, eventId: string): Promise<MatchingReadiness> {
  const [counts, latest] = await Promise.all([getMatchingReadiness(eventId, db), getImportStatusByKind(eventId, db)]);
  const reasons: string[] = [];
  if (counts.buyers === 0) reasons.push("Add at least one active buyer.");
  if (counts.suppliers === 0) reasons.push("Add at least one active supplier.");
  if (counts.buyerRankings === 0) reasons.push("Load the buyer rankings.");
  if (counts.supplierRankings === 0) reasons.push("Load the supplier rankings.");
  for (const [kind, summary] of Object.entries(latest) as [ImportKind, (typeof latest)[ImportKind]][]) {
    if (!summary) continue;
    const label = KIND_LABEL[kind];
    if (summary.state === "needs_mapping") reasons.push(`The ${label} file has unknown names. Map them, then apply the file.`);
    else if (summary.state === "needs_fixes") reasons.push(`The ${label} file has errors. Fix it and upload it again.`);
    else if (summary.state === "ready") reasons.push(`The ${label} file is checked but not applied. Apply it.`);
  }
  return { ready: reasons.length === 0, reasons, counts };
}

/** `matchingReadiness` for pages, in the queries' argument order. */
export function getMatchingGate(eventId: string, db: Db = getDb()): Promise<MatchingReadiness> {
  return matchingReadiness(db, eventId);
}
