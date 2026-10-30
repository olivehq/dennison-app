import { describe, expect, it } from "vitest";
import { describeRebuildUp, describeTargetChanges, fitTargetsToSlots } from "./fit-targets";

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

describe("describeRebuildUp", () => {
  const lowered = { supplierTarget: 7, buyerMin: 7, buyerIdeal: 7, buyerMax: 7 };

  it("says the targets stayed and offers the values from before they were lowered", () => {
    const hint = describeRebuildUp(lowered, 9, 7, TARGETS, TARGETS);
    expect(hint?.note).toBe("Targets stay at 7. Raise them if you want more meetings.");
    expect(hint?.restore).toEqual({ label: "Restore previous targets", targets: TARGETS });
  });

  it("offers the defaults when nothing was lowered in this session", () => {
    const hint = describeRebuildUp({ supplierTarget: 5, buyerMin: 3, buyerIdeal: 4, buyerMax: 5 }, 9, 5, null, TARGETS);
    expect(hint?.note).toBe("Targets stay at 5 per supplier and 3 to 5 per buyer (ideal 4). Raise them if you want more meetings.");
    expect(hint?.restore).toEqual({ label: "Use default targets", targets: TARGETS });
  });

  it("fits the restored values to the new slot count", () => {
    expect(describeRebuildUp(lowered, 8, 6, TARGETS, TARGETS)?.restore?.targets).toEqual({
      supplierTarget: 8,
      buyerMin: 7,
      buyerIdeal: 8,
      buyerMax: 8,
    });
  });

  it("offers no restore when the targets already match the candidate", () => {
    expect(describeRebuildUp(TARGETS, 10, 9, null, TARGETS)?.restore).toBeNull();
  });

  it("says nothing when the count did not grow or the targets reach it", () => {
    expect(describeRebuildUp(lowered, 7, 9, TARGETS, TARGETS)).toBeNull();
    expect(describeRebuildUp(TARGETS, 9, 8, null, TARGETS)).toBeNull();
    expect(describeRebuildUp({ ...TARGETS, buyerMax: Number.NaN }, 12, 9, null, TARGETS)).toBeNull();
  });
});
