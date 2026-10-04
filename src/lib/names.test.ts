import { describe, expect, it } from "vitest";
import { compareNames } from "./names";

describe("compareNames", () => {
  it("ignores case, so lower-case names sit with their letter", () => {
    expect(["eShow", "Everline", "Art", "SEAS Productions", "San Diego"].sort(compareNames)).toEqual([
      "Art",
      "eShow",
      "Everline",
      "San Diego",
      "SEAS Productions",
    ]);
  });

  it("orders numbers by value", () => {
    expect(["Hall 10", "Hall 2", "Hall 1"].sort(compareNames)).toEqual(["Hall 1", "Hall 2", "Hall 10"]);
  });

  it("ignores accents but stays a total order", () => {
    expect(compareNames("Café", "Cafe")).not.toBe(0);
    expect(["Cafe B", "Café A"].sort(compareNames)).toEqual(["Café A", "Cafe B"]);
    expect(compareNames("Alpha", "alpha")).toBe(-compareNames("alpha", "Alpha"));
    expect(compareNames("Same", "Same")).toBe(0);
  });
});
