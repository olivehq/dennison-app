import { describe, expect, it } from "vitest";
import { loadFixture } from "./fixture";
import { buildDemoRankings, fillRankList, mulberry32 } from "./ranks";

describe("mulberry32", () => {
  it("is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seq = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(seq);
    expect(seq.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe("fillRankList", () => {
  it("keeps real ranks, leaves real blanks blank, and fills the rest with unused numbers", () => {
    const targets = ["a", "b", "c", "d", "e"];
    const fixed = new Map<string, number | null>([
      ["b", 1],
      ["d", null],
    ]);
    const result = fillRankList(targets, fixed, mulberry32(1));
    expect(result.get("b")).toBe(1);
    expect(result.get("d")).toBeNull();
    const filled = ["a", "c", "e"].map((t) => result.get(t));
    expect(filled.every((r) => typeof r === "number" && r >= 2 && r <= 5)).toBe(true);
    expect(new Set(filled).size).toBe(3);
  });

  it("widens the pool when a real rank is higher than the number of targets", () => {
    const result = fillRankList(["a", "b"], new Map([["a", 72]]), mulberry32(1));
    expect(result.get("a")).toBe(72);
    expect(result.get("b")).toBeGreaterThanOrEqual(1);
    expect(result.get("b")).not.toBe(72);
  });

  it("refuses a real rank used twice", () => {
    expect(() => fillRankList(["a", "b"], new Map([["a", 1], ["b", 1]]), mulberry32(1))).toThrow(/twice/);
  });
});

describe("buildDemoRankings on the 2025 results", () => {
  const fixture = loadFixture();
  const buyers = fixture.buyers.map((b) => b.name);
  const rows = buildDemoRankings({ buyers, suppliers: fixture.suppliers, appointments: fixture.appointments });
  const key = (ranker: string, target: string) => `${ranker}\u0000${target}`;
  const byPair = new Map(rows.map((r) => [key(r.ranker, r.target), r.rank]));
  const blankBuyerPairs = fixture.appointments.filter((a) => a.buyerRank === null);

  it("ranks every pair except the 17 the buyer left blank in 2025", () => {
    expect(blankBuyerPairs).toHaveLength(17);
    expect(rows.filter((r) => r.rankerType === "buyer")).toHaveLength(65 * 56 - 17);
    expect(rows.filter((r) => r.rankerType === "supplier")).toHaveLength(56 * 65);
    for (const a of blankBuyerPairs) expect(byPair.has(key(a.buyer, a.supplier))).toBe(false);
  });

  it("keeps the real ranks of every matched pair", () => {
    for (const a of fixture.appointments) {
      if (a.buyerRank !== null) expect(byPair.get(key(a.buyer, a.supplier))).toBe(a.buyerRank);
      if (a.supplierRank !== null) expect(byPair.get(key(a.supplier, a.buyer))).toBe(a.supplierRank);
    }
  });

  it("never repeats a number within one ranking list", () => {
    const typeOf = new Map(fixture.suppliers.map((s) => [s.name, s.type]));
    const lists = new Map<string, number[]>();
    for (const r of rows) {
      const list = r.rankerType === "buyer" ? `${r.ranker}|${typeOf.get(r.target)}` : r.ranker;
      lists.set(list, [...(lists.get(list) ?? []), r.rank]);
    }
    expect(lists.size).toBe(65 * 2 + 56);
    for (const ranks of lists.values()) expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("is the same every time", () => {
    expect(buildDemoRankings({ buyers, suppliers: fixture.suppliers, appointments: fixture.appointments })).toEqual(rows);
  });
});
