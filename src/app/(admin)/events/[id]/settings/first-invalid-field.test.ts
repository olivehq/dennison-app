import { describe, expect, it } from "vitest";
import { firstInvalidField } from "./first-invalid-field";

describe("firstInvalidField", () => {
  it("names the field and its message, with the input to focus", () => {
    expect(firstInvalidField({ settings: { hotelRankCutoff: { message: "Enter a whole number from 1 to 500." } } })).toEqual({
      message: "Hotel rank cutoff: Enter a whole number from 1 to 500.",
      id: "hotelRankCutoff",
    });
  });

  it("picks the first field in page order", () => {
    const errors = {
      name: { message: "Enter a name." },
      settings: { buyerMax: { message: "Too many." }, mutualTopN: { message: "Enter a number." } },
    };
    expect(firstInvalidField(errors)?.id).toBe("name");
    expect(firstInvalidField({ settings: errors.settings })?.id).toBe("buyerMax");
  });

  it("points at a slot row before the targets", () => {
    const slots = Object.assign([undefined, { endMinutes: { message: "A slot must end after it starts." } }], {});
    expect(firstInvalidField({ settings: { slots, supplierTarget: { message: "Nope." } } })).toEqual({
      message: "Slot 2 end: A slot must end after it starts.",
      id: "slot-1-end",
    });
  });

  it("falls back to the slots as a whole, and to null when there is nothing", () => {
    const slots = Object.assign([], { message: "Expected 9 slots, got 8." });
    expect(firstInvalidField({ settings: { slots } })).toEqual({ message: "Slots: Expected 9 slots, got 8.", id: "rebuild-count" });
    expect(firstInvalidField({})).toBeNull();
  });
});
