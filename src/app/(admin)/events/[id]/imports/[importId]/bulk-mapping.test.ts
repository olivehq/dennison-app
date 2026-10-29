import { describe, expect, it } from "vitest";
import type { UnknownName } from "@/lib/schemas/import";
import { bulkMappings } from "./bulk-mapping";

function name(raw: string, scores: number[], ambiguous = false): UnknownName {
  return {
    raw,
    entityType: "supplier",
    role: "target",
    rows: [2],
    suggestions: scores.map((score, i) => ({ entityId: `${raw}-${i}`, name: `${raw} ${i}`, score })),
    ...(ambiguous ? { ambiguous: true } : {}),
  };
}

describe("bulkMappings", () => {
  it("takes only near-certain, untied, unambiguous suggestions and counts the rest", () => {
    const names = [
      name("Hyatt Regency Monterey Hotel and Spa", [0.98]),
      name("Hotel Exact Enough", [0.97, 0.5]),
      name("Close but not certain", [0.95]),
      name("Tie", [0.99, 0.99]),
      name("Ann Lee", [1, 1], true),
      name("Nowhere Inn", []),
    ];
    const { take, skipped } = bulkMappings(names);
    expect(take.map((n) => n.raw)).toEqual(["Hyatt Regency Monterey Hotel and Spa", "Hotel Exact Enough"]);
    expect(skipped).toBe(4);
  });
});
