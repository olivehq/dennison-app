import { describe, expect, it } from "vitest";
import { sortFn_name } from "./data-table";

/** Just enough of a TanStack row for a sort function: it only reads the column value. */
const row = (name: string | null) => ({ getValue: () => name }) as unknown as Parameters<typeof sortFn_name>[0];

const sortNames = (names: (string | null)[]) =>
  names
    .map(row)
    .sort((a, b) => sortFn_name(a, b, "name"))
    .map((r) => r.getValue("name"));

describe("sortFn_name", () => {
  it("orders names with compareNames, ignoring case", () => {
    expect(sortNames(["Wyndham", "eShow", "ACWA", "Academic"])).toEqual(["Academic", "ACWA", "eShow", "Wyndham"]);
  });

  it("orders numbers in names by value and puts an empty name first", () => {
    expect(sortNames(["Hall 10", "Hall 2", null])).toEqual([null, "Hall 2", "Hall 10"]);
  });
});
