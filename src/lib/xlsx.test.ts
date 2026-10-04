import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readSheetRows, SPREADSHEET_LIMITS, SpreadsheetTooLargeError, writeSheet } from "./xlsx";

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

  it("rejects a sheet over the row or column limit, and too many sheets", () => {
    const tall = writeSheet(["Email"], Array.from({ length: SPREADSHEET_LIMITS.rows }, (_, i) => [`p${i}@example.com`]));
    expect(() => readSheetRows(tall)).toThrow(SpreadsheetTooLargeError);
    expect(() => readSheetRows(tall)).toThrow(/more than 10,000 rows/);
    const justFits = writeSheet(["Email"], Array.from({ length: SPREADSHEET_LIMITS.rows - 1 }, (_, i) => [`p${i}@example.com`]));
    expect(readSheetRows(justFits)[0].rows).toHaveLength(SPREADSHEET_LIMITS.rows - 1);

    const wide = writeSheet(Array.from({ length: SPREADSHEET_LIMITS.columns + 1 }, (_, i) => `C${i}`), [["x"]]);
    expect(() => readSheetRows(wide)).toThrow(/more than 300 columns/);

    const workbook = XLSX.utils.book_new();
    for (let i = 0; i <= SPREADSHEET_LIMITS.sheets; i += 1) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["A"], ["1"]]), `S${i}`);
    }
    const many = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Uint8Array);
    expect(() => readSheetRows(many)).toThrow(/21 sheets/);
  });

  it("checks rows against the full range, not the range cut short by sheetRows", () => {
    // Data starting at row 6: the cut range (rows 6 to 10,001) is under the limit, the real one is not.
    const rows = SPREADSHEET_LIMITS.rows + 1;
    const sheet: XLSX.WorkSheet = {};
    XLSX.utils.sheet_add_aoa(sheet, [["Email"], ...Array.from({ length: rows - 1 }, (_, i) => [`p${i}@example.com`])], {
      origin: "A6",
    });
    sheet["!ref"] = `A6:A${5 + rows}`;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Offset");
    const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Uint8Array);
    expect(() => readSheetRows(buffer)).toThrow(/more than 10,000 rows/);
  });
});
