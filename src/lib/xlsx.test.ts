import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSheetRows, writeSheet } from "./xlsx";

describe("xlsx", () => {
  it("round-trips headers and rows, trims cells, and drops empty rows", () => {
    const buffer = writeSheet(
      ["Email", "First name", "Count"],
      [
        { Email: " ann@example.com ", "First name": "Ann", Count: 3 },
        { Email: "", "First name": "", Count: "" },
        ["bob@example.com", "Bob", null],
      ],
      "People",
    );
    const [sheet] = readSheetRows(buffer);
    expect(sheet.sheetName).toBe("People");
    expect(sheet.headers).toEqual(["Email", "First name", "Count"]);
    expect(sheet.rows).toEqual([
      { Email: "ann@example.com", "First name": "Ann", Count: "3" },
      { Email: "bob@example.com", "First name": "Bob", Count: "" },
    ]);
    expect(sheet.rowNumbers).toEqual([2, 4]);
  });

  it("keeps a blank first header and suffixes duplicate headers", () => {
    const buffer = writeSheet(["", "Hotel A", "Hotel A", "Hotel B"], [["Buyer 1", 1, 2, "N/A"]]);
    const [sheet] = readSheetRows(buffer);
    expect(sheet.headers).toEqual(["", "Hotel A", "Hotel A (2)", "Hotel B"]);
    expect(sheet.rows[0]).toEqual({ "": "Buyer 1", "Hotel A": "1", "Hotel A (2)": "2", "Hotel B": "N/A" });
  });

  it("reads csv too", () => {
    const csv = Buffer.from("Email,First name\nann@example.com,Ann\n\n", "utf8");
    const [sheet] = readSheetRows(csv);
    expect(sheet.headers).toEqual(["Email", "First name"]);
    expect(sheet.rows).toEqual([{ Email: "ann@example.com", "First name": "Ann" }]);
  });

  it("reads the eShow sample export", () => {
    const buffer = readFileSync("fixtures/eshow-2026-sample-ratings.xlsx");
    const sheets = readSheetRows(buffer);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].sheetName).toBe("Report");
    expect(sheets[0].headers.slice(0, 4)).toEqual(["FIRST_NAME", "LAST_NAME", "FULL_NAME", "CHOICE #1"]);
    expect(sheets[0].headers).toHaveLength(43);
    expect(sheets[0].rows).toHaveLength(2);
  });
});
