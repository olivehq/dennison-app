import { describe, expect, it } from "vitest";
import { filterHistory, parseHistoryFilters } from "./history-filters";

describe("parseHistoryFilters", () => {
  it("keeps known file types and states and reads anything else as all", () => {
    expect(parseHistoryFilters({ type: "suppliers", state: "needs_mapping", q: "hotel" })).toEqual({
      type: "suppliers",
      state: "needs_mapping",
      q: "hotel",
    });
    expect(parseHistoryFilters({ type: "nope", state: ["applied"] })).toEqual({ type: "all", state: "all", q: "" });
  });
});

describe("filterHistory", () => {
  const rows = [
    { id: "1", kind: "participants" as const, state: "applied" as const },
    { id: "2", kind: "suppliers" as const, state: "ready" as const },
    { id: "3", kind: "suppliers" as const, state: "applied" as const },
  ];

  it("filters by file type and state together", () => {
    expect(filterHistory(rows, { type: "all", state: "all" }).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(filterHistory(rows, { type: "suppliers", state: "all" }).map((r) => r.id)).toEqual(["2", "3"]);
    expect(filterHistory(rows, { type: "suppliers", state: "applied" }).map((r) => r.id)).toEqual(["3"]);
    expect(filterHistory(rows, { type: "participants", state: "ready" })).toEqual([]);
  });
});
