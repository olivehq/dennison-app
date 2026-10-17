import type { ImportKind, ImportState } from "@/lib/schemas/import";
import { importKinds, type ImportSummary } from "@/server/imports/queries";
import type { MatchingReadiness } from "@/server/matching/readiness";

export type KindStatus =
  | { kind: ImportKind; status: "applied" | "not_uploaded" }
  | { kind: ImportKind; status: "pending"; importId: string; state: ImportState };

export type ReadinessPanelModel = {
  ready: boolean;
  title: string;
  /** The matching gate's reasons, in the order to fix them. Empty when ready. */
  reasons: string[];
  /** The latest file of each kind that isn't ignored. */
  kinds: KindStatus[];
  /** The first file, in step order, that is uploaded but not applied: where the line's review link goes. */
  review: { kind: ImportKind; importId: string } | null;
};

/**
 * The Upload page's readiness line. Ready, the copy, and the
 * reasons come from the matching gate (D88), so this panel and the Run
 * buttons never disagree: rankings loaded without a file (the seed) count,
 * and an empty roster blocks even with every file applied.
 */
export function readinessPanelModel(
  gate: MatchingReadiness,
  byKind: Record<ImportKind, ImportSummary | null>,
): ReadinessPanelModel {
  const kinds = importKinds.map((kind): KindStatus => {
    const latest = byKind[kind];
    if (!latest) return { kind, status: "not_uploaded" };
    if (latest.state === "applied") return { kind, status: "applied" };
    return { kind, status: "pending", importId: latest.id, state: latest.state };
  });
  const pending = kinds.find((entry) => entry.status === "pending");
  return {
    ready: gate.ready,
    title: gate.ready ? "Ready to match" : "Not ready to match",
    reasons: gate.reasons,
    kinds,
    review: pending?.status === "pending" ? { kind: pending.kind, importId: pending.importId } : null,
  };
}
