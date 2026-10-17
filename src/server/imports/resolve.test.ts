import { describe, expect, it } from "vitest";
import { emailIn, normaliseName, resolveNames, similarity } from "./resolve";

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

  it("marks a shared name ambiguous and lists every match, sorted by name", () => {
    const twins = [
      { id: "z", label: "Ann Lee (Zenith)", names: ["Ann Lee"] },
      { id: "a", label: "Ann Lee (Acme)", names: ["Ann Lee"] },
      { id: "c", label: "Ann Leeds", names: ["Ann Leeds"] },
    ];
    const result = resolveNames(["Ann Lee"], twins, []);
    expect(result.unresolved).toEqual([
      {
        raw: "Ann Lee",
        ambiguous: true,
        suggestions: [
          { entityId: "a", name: "Ann Lee (Acme)", score: 1 },
          { entityId: "z", name: "Ann Lee (Zenith)", score: 1 },
        ],
      },
    ]);
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

  it("sends a shared name to mapping even when a cross-year alias names someone else", () => {
    const people = [
      { id: "a", label: "Annie Lee (Acme)", names: ["Annie Lee"], canonicalName: "Annie Lee" },
      { id: "z", label: "Annie Lee (Zenith)", names: ["Annie Lee"], canonicalName: "Annie Lee" },
      { id: "s", label: "Ann Lee Smith", names: ["Ann Lee Smith"] },
      { id: "n1", label: "Bo Ray", names: ["Bo Ray"] },
      { id: "n2", label: "Bo-Ray", names: ["Bo-Ray"] },
    ];
    const result = resolveNames(["annie lee", "Bo  Ray!"], people, [], [
      { rawText: "Annie Lee", canonicalName: "Ann Lee Smith" },
      { rawText: "Bo  Ray!", canonicalName: "Ann Lee Smith" },
    ]);
    expect(result.resolved.size).toBe(0);
    expect(result.unresolved.map((u) => [u.raw, u.ambiguous, u.suggestions.map((s) => s.entityId).sort()])).toEqual([
      ["annie lee", true, ["a", "z"]],
      // Shared after normalising ("bo ray") counts too.
      ["Bo  Ray!", true, ["n1", "n2"]],
    ]);
  });
});

describe("emailIn", () => {
  it("finds an email anywhere in the text, lower-cased", () => {
    expect(emailIn("DSmith@Example.com")).toBe("dsmith@example.com");
    expect(emailIn("David Smith <ds@example.com>")).toBe("ds@example.com");
    expect(emailIn("David Smith (ds@example.com), GHI")).toBe("ds@example.com");
    expect(emailIn("GHI Association")).toBeNull();
    expect(emailIn("someone@localhost")).toBeNull();
  });
});

describe("resolveNames for buyers named by email or company", () => {
  const buyers = [
    { id: "jane", label: "Jane Doe (ABC Association)", names: ["Jane Doe"], emails: ["jdoe@example.com"], organization: "ABC Association" },
    { id: "d1", label: "David Smith (GHI Association)", names: ["David Smith"], emails: ["ds1@example.com"], organization: "GHI Association" },
    { id: "d2", label: "David Smith (GHI Association)", names: ["David Smith"], emails: ["ds2@example.com"], organization: "GHI Association" },
    { id: "abc", label: "Abc Association", names: ["Abc Association"], emails: ["abc@example.com"], organization: null },
  ];
  const options = { byEmail: true, byOrganization: true };

  it("matches email, then this event's alias, then a company one buyer has, then names", () => {
    const result = resolveNames(
      ["ds2@example.com", "Jane's company", "abc association", "The ABC Association.", "Jane Doe"],
      buyers,
      [
        { rawText: "Jane's company", entityId: "jane" },
        // An alias for an email text never applies: the email decides.
        { rawText: "ds2@example.com", entityId: "d1" },
      ],
      [],
      options,
    );
    expect(result.resolved.get("ds2@example.com")).toBe("d2");
    expect(result.resolved.get("Jane's company")).toBe("jane");
    // The company comes before a name that matches the same text.
    expect(result.resolved.get("abc association")).toBe("jane");
    expect(result.resolved.get("The ABC Association.")).toBe("jane");
    expect(result.resolved.get("Jane Doe")).toBe("jane");
    expect(result.inexact.size).toBe(0);
    expect(result.aliasedAmbiguous.size).toBe(0);
  });

  it("leaves an unknown email unresolved and never falls back to the name around it", () => {
    const result = resolveNames(["Jane Doe <jane@elsewhere.com>"], buyers, [], [], options);
    expect(result.resolved.size).toBe(0);
    expect(result.unresolved[0]).toMatchObject({ raw: "Jane Doe <jane@elsewhere.com>" });
    expect(result.unresolved[0].ambiguous).toBeUndefined();
    expect(result.unresolved[0].suggestions[0].entityId).toBe("jane");
  });

  it("sends a shared company to mapping even when a cross-year alias names one of them", () => {
    const result = resolveNames(["GHI Association"], buyers, [], [{ rawText: "GHI Association", canonicalName: "David Smith" }], options);
    expect(result.resolved.size).toBe(0);
    expect(result.unresolved[0]).toMatchObject({ raw: "GHI Association", ambiguous: true });
    expect(result.unresolved[0].suggestions.map((s) => s.entityId).sort()).toEqual(["d1", "d2"]);
  });

  it("resolves a shared company or name through this event's alias and reports it as ambiguous", () => {
    const result = resolveNames(
      ["GHI Association", "David Smith", "Jane Doe"],
      buyers,
      [
        { rawText: "GHI Association", entityId: "d1" },
        { rawText: "David Smith", entityId: "d2" },
        { rawText: "Jane Doe", entityId: "jane" },
      ],
      [],
      options,
    );
    expect(result.resolved.get("GHI Association")).toBe("d1");
    expect(result.resolved.get("David Smith")).toBe("d2");
    expect([...result.aliasedAmbiguous.keys()].sort()).toEqual(["David Smith", "GHI Association"]);
    expect(result.aliasedAmbiguous.get("GHI Association")?.sort()).toEqual(["d1", "d2"]);
  });

  it("does not look at emails or companies unless asked", () => {
    const result = resolveNames(["ds2@example.com", "ABC Association"], buyers, [], []);
    expect(result.resolved.get("ABC Association")).toBe("abc");
    expect(result.resolved.has("ds2@example.com")).toBe(false);
  });
});
