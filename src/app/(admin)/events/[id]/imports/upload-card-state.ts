import { isRankingKind, type ImportKind, type ImportState, type ImportValidationReport } from "@/lib/schemas/import";
import { plural } from "./import-labels";

export type UploadCardFile = {
  state: ImportState;
  counts: ImportValidationReport["counts"] | null;
};

export type UploadCardState = {
  pill: ImportState | "not_uploaded";
  /** Worded count after the pill label, for example "70 people". */
  count: string | null;
  /**
   * The one primary action. "choose" opens the file picker; "review" links to
   * the file's report, where it gets mapped and applied.
   */
  action: { label: "Choose file" | "Upload new file"; kind: "choose" } | { label: "Review and apply" | "Fix names"; kind: "review" };
};

const ROSTER_NOUNS: Partial<Record<ImportKind, [string, string]>> = {
  participants: ["person", "people"],
  suppliers: ["supplier", "suppliers"],
};

/**
 * What an upload card shows for the latest file of its kind that isn't
 * ignored (`latest`), or for the latest ignored file when every file of the
 * kind is ignored (`ignored`).
 */
export function uploadCardState(kind: ImportKind, latest: UploadCardFile | null, ignored: UploadCardFile | null): UploadCardState {
  if (!latest) {
    return ignored
      ? { pill: "ignored", count: null, action: { label: "Upload new file", kind: "choose" } }
      : { pill: "not_uploaded", count: null, action: { label: "Choose file", kind: "choose" } };
  }
  const counts = latest.counts;
  switch (latest.state) {
    case "applied": {
      const nouns = ROSTER_NOUNS[kind];
      const count = !counts
        ? null
        : isRankingKind(kind)
          ? plural(counts.rankings, "ranking")
          : nouns
            ? plural(counts.rows, nouns[0], nouns[1])
            : plural(counts.rows, "row");
      return { pill: "applied", count, action: { label: "Upload new file", kind: "choose" } };
    }
    case "ready":
      return { pill: "ready", count: null, action: { label: "Review and apply", kind: "review" } };
    case "needs_mapping":
      return {
        pill: "needs_mapping",
        count: counts && counts.unknownNames > 0 ? plural(counts.unknownNames, "name") : null,
        action: { label: "Fix names", kind: "review" },
      };
    case "needs_fixes":
      return {
        pill: "needs_fixes",
        count: counts && counts.errors > 0 ? plural(counts.errors, "error") : null,
        action: { label: "Upload new file", kind: "choose" },
      };
    case "failed":
      return { pill: "failed", count: null, action: { label: "Upload new file", kind: "choose" } };
    case "ignored":
      return { pill: "ignored", count: null, action: { label: "Upload new file", kind: "choose" } };
  }
}
