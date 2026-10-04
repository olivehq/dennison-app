import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeStats, type Appointment } from "@/engine";
import { defaultEventSettings } from "@/lib/schemas/event-settings";
import { neitherBandLines, qualityReportText } from "./report";

type Fixture = {
  buyers: { name: string }[];
  suppliers: { name: string; type: "business" | "hotel" }[];
  appointments: { slot: number; supplier: string; buyer: string; buyerRank: number | null; supplierRank: number | null }[];
};

/** fixtures/aw-2025-results.js assigns `window.AW_DATA = {...}`; ids are the names here. */
function load2025(): Fixture {
  const source = readFileSync(resolve(process.cwd(), "fixtures/aw-2025-results.js"), "utf8");
  return JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1)) as Fixture;
}

const data = load2025();
const appointments: Appointment[] = data.appointments.map((a) => ({
  slot: a.slot,
  buyerId: a.buyer,
  supplierId: a.supplier,
  buyerRank: a.buyerRank,
  supplierRank: a.supplierRank,
  source: "engine",
  pinned: false,
}));
const stats = computeStats(appointments, {
  settings: defaultEventSettings,
  buyers: data.buyers.map((b) => ({ id: b.name, biztechOptIn: true })),
  suppliers: data.suppliers.map((s) => ({ id: s.name, type: s.type })),
});
const view = { buyers: data.buyers.map((b) => ({ id: b.name, name: b.name, withdrawn: false })) };
const event = {
  name: "AW 2025 Appointment Show",
  eventDate: "2025-11-14",
  timezone: "America/Los_Angeles",
  settings: { slotCount: 9 },
};
const text = qualityReportText(view, stats, event);

describe("qualityReportText against the 2025 results", () => {
  it("has every section heading in order, in the spec's wording", () => {
    const headings = [
      "A. OVERALL STATISTICS",
      "B. MUTUAL TOP-10 MATCHES",
      "C. ONE-SIDE TOP-10 MATCHES (but not mutual)",
      "D. NEITHER SIDE TOP-10",
      "E. BLANK RANKINGS",
      "F. QUALITY SUMMARY",
      "G. KEY INSIGHTS",
    ];
    const positions = headings.map((h) => text.split("\n").indexOf(h));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain("Friday, November 14, 2025");
  });

  it("prints section A from the stats", () => {
    expect(text).toContain("- Total appointments: 504");
    expect(text).toContain("- Total buyers: 65");
    expect(text).toContain("- Total suppliers: 56");
    expect(text).toContain("  * 9 appointments: 4 buyers");
    expect(text).toContain("  * 8 appointments: 45 buyers");
    expect(text).toContain("  * 7 appointments: 13 buyers");
    expect(text).toContain("  * 6 appointments: 2 buyers");
    expect(text).toContain("  * 5 or fewer: 1 buyer");
    expect(text).toContain("- Supplier success rate: 100.0% with exactly 9 appointments");
  });

  it("lists the buyers below and above target by name", () => {
    expect(text).toContain("- Buyers below target (fewer than 7): 3");
    const below = stats.buyersBelowMin.map((b) => b.id);
    for (const name of below) expect(text).toContain(`  * ${name}: `);
    expect(text).toContain("- Buyers above target (more than 9): 0\n  * None");
  });

  it("prints sections B to E", () => {
    expect(text).toContain("- Count: 126 appointments (25.0%)");
    expect(text).toContain("- Total: 330 appointments (65.5%)");
    expect(text).toContain("  * 209 appointments: Buyer ranked supplier in top-10, but supplier ranked buyer lower (rank >10)");
    expect(text).toContain("  * 121 appointments: Supplier ranked buyer in top-10, but buyer ranked supplier lower (rank >10)");
    expect(text).toContain("- Total: 31 appointments (6.2%) where both ranked each other but neither in top 10");
    expect(text).toContain("  * Mutual ranks 11-20: 1 appointment");
    expect(text).toContain("  * Mutual ranks 21-27: 1 appointment");
    expect(text).toContain("  * Mutual ranks >27: 4 appointments");
    expect(text).toContain("  * Mixed rankings (one side 11-27, other higher/lower): 25 appointments");
    expect(text).toContain("- Total: 17 appointments (3.4%)");
  });

  it("prints the quality summary lines with their markers", () => {
    expect(text).toContain("✅ High Quality (Mutual top-10): 126 appointments (25.0%)");
    expect(text).toContain("⚠️ Medium Quality (One side top-10): 330 appointments (65.5%)");
    expect(text).toContain("⚠️ Lower Quality (Neither top-10): 31 appointments (6.2%)");
    expect(text).toContain("ℹ️ Blank rankings: 17 appointments (3.4%)");
  });

  it("computes the key insights from the numbers", () => {
    expect(text).toContain("- 92.1% of appointments (464 of 504) have at least one party in the other's top 10.");
    expect(text).toContain("filling every supplier to exactly 9 (56 of 56 reached it)");
    expect(text).toContain("keeping buyers between 7 and 9 (62 of 65 are)");
    expect(text).toContain("25 of the 31 are mixed rankings");
    expect(text).toContain("3 buyers have fewer than 7 appointments.");
  });
});

describe("neitherBandLines", () => {
  it("never prints a backwards band when the cutoff is at or below 2N", () => {
    const low = computeStats(appointments, {
      settings: { ...defaultEventSettings, mutualTopN: 10, hotelRankCutoff: 15 },
      buyers: data.buyers.map((b) => ({ id: b.name, biztechOptIn: true })),
      suppliers: data.suppliers.map((s) => ({ id: s.name, type: s.type })),
    });
    const lines = neitherBandLines(low);
    expect(lines.map((line) => line.split(":")[0])).toEqual([
      "  * Mutual ranks 11-20",
      "  * Mutual ranks >20",
      "  * Mixed rankings (one side 11-20, other higher/lower)",
    ]);
    expect(lines.join("\n")).not.toMatch(/21-15/);
  });

  it("keeps the three ranges with the default cutoff above 2N", () => {
    expect(neitherBandLines(stats).map((line) => line.split(":")[0])).toEqual([
      "  * Mutual ranks 11-20",
      "  * Mutual ranks 21-27",
      "  * Mutual ranks >27",
      "  * Mixed rankings (one side 11-27, other higher/lower)",
    ]);
  });
});
