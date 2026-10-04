import { describe, expect, it } from "vitest";
import { BOM, csvCell, toCsv } from "./common";

describe("csvCell", () => {
  it("prefixes text that starts like a formula with a single quote", () => {
    for (const value of ["=1+1", "+44 20", "-cmd", "@SUM(A1)", "\tTab", "\rReturn"]) {
      expect(csvCell(value)).toBe(`'${value}`);
    }
  });

  it("leaves ordinary text and numbers alone", () => {
    expect(csvCell("Ann Lee")).toBe("Ann Lee");
    expect(csvCell("Desk 4 - A=B")).toBe("Desk 4 - A=B");
    expect(csvCell(-3)).toBe(-3);
    expect(csvCell("")).toBe("");
  });
});

describe("toCsv", () => {
  it("escapes formula cells in every row", () => {
    const csv = toCsv(["Name", "Rank"], [["=HYPERLINK(\"http://evil\")", 1], ["Ann", 2]]);
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(BOM.length).trim().split("\n");
    expect(lines[0]).toBe("Name,Rank");
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil"")",1`);
    expect(lines[2]).toBe("Ann,2");
  });
});
