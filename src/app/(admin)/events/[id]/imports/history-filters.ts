import { importKindSchema, importStateSchema, type ImportKind, type ImportState } from "@/lib/schemas/import";

/** The History page's filters as they sit in the URL: `type`, `state`, and `q`. Bad values read as "all". */
export type HistoryFilters = {
  type: ImportKind | "all";
  state: ImportState | "all";
  q: string;
};

export function parseHistoryFilters(raw: Record<string, string | string[] | undefined>): HistoryFilters {
  const one = (key: string) => (typeof raw[key] === "string" ? raw[key] : "");
  const type = importKindSchema.safeParse(one("type"));
  const state = importStateSchema.safeParse(one("state"));
  return { type: type.success ? type.data : "all", state: state.success ? state.data : "all", q: one("q").slice(0, 200) };
}

/** Rows of this file type and state. The filename search is the table's own. */
export function filterHistory<Row extends { kind: ImportKind; state: ImportState }>(
  rows: Row[],
  filters: Pick<HistoryFilters, "type" | "state">,
): Row[] {
  return rows.filter(
    (row) => (filters.type === "all" || row.kind === filters.type) && (filters.state === "all" || row.state === filters.state),
  );
}
