import { describe, expect, it } from "vitest";
import { normaliseName, resolveNames, similarity } from "./resolve";

const entities = [
  { id: "hyatt", label: "Hyatt Regency Monterey Hotel & Spa", names: ["Hyatt Regency Monterey Hotel & Spa"] },
  { id: "slo", label: "Visit SLO CAL", names: ["Visit SLO CAL"] },
  { id: "plaza", label: "Monterey Plaza Hotel & Spa", names: ["Monterey Plaza Hotel & Spa"] },
  { id: "eshow", label: "eShow", names: ["eShow"] },
  { id: "lakehouse", label: "Lakehouse Resort", names: ["Lakehouse Resort"] },
];

describe("normaliseName", () => {
  it("drops punctuation, articles, and ampersands", () => {
    expect(normaliseName("The Lakehouse Resort")).toBe("lakehouse resort");
    expect(normaliseName("Hyatt Regency Monterey Hotel & Spa")).toBe("hyatt regency monterey hotel and spa");
    expect(normaliseName("  Visit   S.L.O. CAL ")).toBe("visit s l o cal");
  });
});

describe("similarity", () => {
  it("scores close names high and unrelated names low", () => {
    expect(similarity("Hyatt Regency Monterey", "Hyatt Regency Monterey Hotel & Spa")).toBeGreaterThan(0.75);
    expect(similarity("eShow", "Visit SLO CAL")).toBeLessThan(0.3);
    expect(similarity("Same", "Same")).toBe(1);
  });
});

describe("resolveNames", () => {
  it("prefers an alias, then exact, then normalised, and suggests the rest", () => {
    const result = resolveNames(
      ["Hyatt Monterey", "visit slo cal", "The Lakehouse Resort", "Hyatt Regency Monterey", "Nowhere Inn"],
      entities,
      [{ rawText: "Hyatt Monterey", entityId: "hyatt" }],
    );
    expect(result.resolved.get("Hyatt Monterey")).toBe("hyatt");
    expect(result.resolved.get("visit slo cal")).toBe("slo");
    expect(result.resolved.get("The Lakehouse Resort")).toBe("lakehouse");
    expect(result.inexact.get("The Lakehouse Resort")).toBe("lakehouse");
    expect(result.inexact.has("visit slo cal")).toBe(false);

    expect(result.unresolved.map((u) => u.raw)).toEqual(["Hyatt Regency Monterey", "Nowhere Inn"]);
    const hyatt = result.unresolved[0];
    expect(hyatt.suggestions[0].entityId).toBe("hyatt");
    expect(hyatt.suggestions[0].score).toBeGreaterThan(0.75);
    expect(hyatt.suggestions.length).toBeLessThanOrEqual(3);
    expect(result.unresolved[1].suggestions).toEqual([]);
  });

  it("leaves an ambiguous name unresolved with every candidate suggested", () => {
    const twins = [
      { id: "a", label: "Ann Lee (HelmsBriscoe)", names: ["Ann Lee"] },
      { id: "b", label: "Ann Lee (Acme)", names: ["Ann Lee"] },
    ];
    const result = resolveNames(["ann lee"], twins, []);
    expect(result.resolved.size).toBe(0);
    expect(result.unresolved[0].suggestions.map((s) => s.entityId).sort()).toEqual(["a", "b"]);
  });

  it("ignores aliases that point at entities no longer on the roster", () => {
    const result = resolveNames(["Gone Hotel"], entities, [{ rawText: "Gone Hotel", entityId: "deleted" }]);
    expect(result.resolved.size).toBe(0);
    expect(result.unresolved).toHaveLength(1);
  });

  it("uses this event's alias first, then a cross-year alias by canonical name, before matching names", () => {
    const result = resolveNames(
      ["Hyatt Monterey", "MONTEREY HYATT", "Plaza", "eShow", "Gone"],
      entities,
      [{ rawText: "Hyatt Monterey", entityId: "plaza" }],
      [
        { rawText: "hyatt monterey", canonicalName: "Hyatt Regency Monterey Hotel & Spa" },
        { rawText: "Monterey Hyatt", canonicalName: "hyatt regency monterey hotel & spa" },
        { rawText: "Plaza", canonicalName: "Monterey Plaza Hotel & Spa" },
        { rawText: "eShow", canonicalName: "Visit SLO CAL" },
        { rawText: "Gone", canonicalName: "A hotel that closed" },
      ],
    );
    // The event alias wins over the global one for the same raw text.
    expect(result.resolved.get("Hyatt Monterey")).toBe("plaza");
    // Global aliases match raw text and canonical name ignoring case.
    expect(result.resolved.get("MONTEREY HYATT")).toBe("hyatt");
    expect(result.resolved.get("Plaza")).toBe("plaza");
    // A global alias comes before an exact name match.
    expect(result.resolved.get("eShow")).toBe("slo");
    // A canonical name no entity here has is skipped.
    expect(result.resolved.has("Gone")).toBe(false);
    expect(result.inexact.size).toBe(0);
  });
});
