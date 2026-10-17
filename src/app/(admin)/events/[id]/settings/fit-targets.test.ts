import { describe, expect, it } from "vitest";
import { describeTargetChanges, fitTargetsToSlots } from "./fit-targets";

const TARGETS = { supplierTarget: 9, buyerMin: 7, buyerIdeal: 8, buyerMax: 9 };

describe("fitTargetsToSlots", () => {
  it("leaves targets that fit alone", () => {
    expect(fitTargetsToSlots(TARGETS, 9)).toEqual({ targets: TARGETS, changes: [] });
    expect(fitTargetsToSlots(TARGETS, 12).changes).toEqual([]);
  });

  it("lowers every target above the slot count and keeps min <= ideal <= max", () => {
    const { targets, changes } = fitTargetsToSlots(TARGETS, 6);
    expect(targets).toEqual({ supplierTarget: 6, buyerMin: 6, buyerIdeal: 6, buyerMax: 6 });
    expect(changes).toEqual([
      { field: "supplierTarget", from: 9, to: 6 },
      { field: "buyerMin", from: 7, to: 6 },
      { field: "buyerIdeal", from: 8, to: 6 },
      { field: "buyerMax", from: 9, to: 6 },
    ]);
    expect(describeTargetChanges(changes)).toBe(
      "Lowered meetings per supplier to 6, buyer minimum to 6, buyer ideal to 6 and buyer maximum to 6 to fit.",
    );
  });

  it("lowers only what no longer fits", () => {
    const { targets, changes } = fitTargetsToSlots(TARGETS, 8);
    expect(targets).toEqual({ supplierTarget: 8, buyerMin: 7, buyerIdeal: 8, buyerMax: 8 });
    expect(describeTargetChanges(changes)).toBe("Lowered meetings per supplier to 8 and buyer maximum to 8 to fit.");
  });

  it("raises an ideal below the minimum", () => {
    const { targets, changes } = fitTargetsToSlots({ supplierTarget: 3, buyerMin: 3, buyerIdeal: 1, buyerMax: 5 }, 9);
    expect(targets.buyerIdeal).toBe(3);
    expect(describeTargetChanges(changes)).toBe("Raised buyer ideal to 3 to fit.");
  });

  it("leaves a blank field for the form's validation", () => {
    const { targets, changes } = fitTargetsToSlots({ ...TARGETS, buyerMax: Number.NaN }, 6);
    expect(Number.isNaN(targets.buyerMax)).toBe(true);
    expect(targets).toMatchObject({ supplierTarget: 6, buyerMin: 6, buyerIdeal: 6 });
    expect(changes.map((c) => c.field)).toEqual(["supplierTarget", "buyerMin", "buyerIdeal"]);
  });

  it("says nothing when nothing changed", () => {
    expect(describeTargetChanges([])).toBeNull();
  });
});
