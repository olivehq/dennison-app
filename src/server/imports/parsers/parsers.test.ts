import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSheetRows, writeSheet } from "@/lib/xlsx";
import { detectFormat, detectShape, templateWorkbook } from "../templates";
import { isStructuralFailure, parseImportFile, parseParticipants, parseRankingList, parseRankingMatrix, parseSuppliers } from "./index";

const sheetOf = (buffer: Buffer) => readSheetRows(buffer)[0];

describe("detectFormat", () => {
  it("recognises the eShow list, the 2025 matrix, and nothing else", () => {
    expect(detectFormat(["FIRST_NAME", "LAST_NAME", "FULL_NAME", "CHOICE #1", "CHOICE #2"])).toBe("list");
    expect(detectFormat(["Name", "Choice 1", "choice#2"])).toBe("list");
    expect(detectFormat(["", "Hyatt Regency Monterey", "Visit SLO CAL"])).toBe("matrix");
    expect(detectFormat(["Name", "Hyatt Regency Monterey", "Visit SLO CAL"])).toBe("matrix");
    expect(detectFormat(["Email", "First name", "Last name"])).toBe("unknown");
    expect(detectFormat(["", "Only one"])).toBe("unknown");
  });
});

describe("parseParticipants", () => {
  it("reads the template with flexible headers and yes/no opt-in", () => {
    const sheet = sheetOf(
      writeSheet(
        ["EMAIL", "First Name", "Last Name", "Company", "Title", "Biztech opt-in"],
        [
          ["Ann@Example.com", "Ann", "Lee", "HelmsBriscoe", "Director", "Yes"],
          ["bob@example.com", "Bob", "Ray", "", "", ""],
          ["", "No", "Email", "", "", ""],
          ["not-an-email", "Bad", "Email", "", "", ""],
          ["cat@example.com", "Cat", "Day", "", "", "maybe"],
          ["dan@example.com", "", "Only", "", "", ""],
        ],
      ),
    );
    const result = parseParticipants(sheet);
    expect(result.rows).toEqual([
      { row: 2, email: "ann@example.com", firstName: "Ann", lastName: "Lee", organization: "HelmsBriscoe", title: "Director", biztechOptIn: true },
      { row: 3, email: "bob@example.com", firstName: "Bob", lastName: "Ray", organization: null, title: null, biztechOptIn: null },
    ]);
    expect(result.errors.map((e) => e.row)).toEqual([4, 5, 6, 7]);
    expect(result.errors[0]).toMatchObject({ code: "missing_email" });
  });

  it("reports missing required columns once", () => {
    const sheet = sheetOf(writeSheet(["First name", "Last name"], [["Ann", "Lee"]]));
    const result = parseParticipants(sheet);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ row: null, message: 'Missing required column: "Email".' }]);
  });
});

describe("parseSuppliers", () => {
  it("reads types and contacts", () => {
    const sheet = sheetOf(
      writeSheet(
        ["Name", "Type", "Admin contact name", "Admin contact email", "Attendee contact name", "Attendee contact email"],
        [
          ["eShow", "Business", "Pat", "pat@eshow.com", "", ""],
          ["Visit SLO CAL", "hotel", "", "", "Sam", "SAM@slocal.com"],
          ["Mystery", "venue", "", "", "", ""],
          ["Bad Email Co", "hotel", "X", "nope", "", ""],
          ["", "hotel", "", "", "", ""],
        ],
      ),
    );
    const result = parseSuppliers(sheet);
    expect(result.rows).toEqual([
      { row: 2, name: "eShow", type: "business", adminContactName: "Pat", adminContactEmail: "pat@eshow.com", attendeeContactName: null, attendeeContactEmail: null },
      { row: 3, name: "Visit SLO CAL", type: "hotel", adminContactName: null, adminContactEmail: null, attendeeContactName: "Sam", attendeeContactEmail: "sam@slocal.com" },
    ]);
    expect(result.errors.map((e) => e.row)).toEqual([4, 5, 6]);
  });

  it("refuses type words that are only names on Object.prototype", () => {
    const sheet = sheetOf(
      writeSheet(["Name", "Type"], [["A", "constructor"], ["B", "__proto__"], ["C", "toString"], ["D", "hasOwnProperty"]]),
    );
    const result = parseSuppliers(sheet);
    expect(result.rows).toEqual([]);
    expect(result.errors.map((e) => e.message)).toEqual([
      'A: type must be business or hotel, got "constructor".',
      'B: type must be business or hotel, got "__proto__".',
      'C: type must be business or hotel, got "toString".',
      'D: type must be business or hotel, got "hasOwnProperty".',
    ]);
  });
});

describe("parseRankingList", () => {
  it("parses the real eShow sample: one empty ranker and one with 25 choices", () => {
    const sheet = sheetOf(readFileSync("fixtures/eshow-2026-sample-ratings.xlsx"));
    const result = parseRankingList(sheet);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ row: 2, rankerName: "Jamie Test", rankerEmail: null, choices: [] });
    const second = result.rows[1];
    expect(second.rankerName).toBe("TestFirst1 TestLast1");
    expect(second.choices).toHaveLength(25);
    expect(second.choices[0]).toEqual({ rank: 1, targetName: "SEAS Productions" });
    expect(second.choices[24]).toEqual({ rank: 25, targetName: "Visit Rancho Cordova" });
  });

  it("uses the column number as the rank, falls back to first and last name, and reads an email", () => {
    const sheet = sheetOf(
      writeSheet(
        ["FIRST_NAME", "LAST_NAME", "EMAIL", "CHOICE #3", "CHOICE #1", "CHOICE #2"],
        [
          ["Ann", "Lee", "ann@example.com", "C", "A", ""],
          ["Bob", "Ray", "", "", "", ""],
          ["", "", "bad", "", "", ""],
        ],
      ),
    );
    const result = parseRankingList(sheet);
    expect(result.rows[0]).toEqual({
      row: 2,
      rankerName: "Ann Lee",
      rankerEmail: "ann@example.com",
      choices: [
        { rank: 1, targetName: "A" },
        { rank: 3, targetName: "C" },
      ],
    });
    expect(result.rows[1].choices).toEqual([]);
    expect(result.errors).toEqual([{ row: 4, message: '"bad" is not a valid email address.' }]);
  });

  it("accepts CHOICE #10000 and refuses a column numbered 0 or past it as a file-level error", () => {
    const fits = parseRankingList(sheetOf(writeSheet(["FULL_NAME", "CHOICE #10000"], [["Ann Lee", "A"]])));
    expect(fits.rows[0].choices).toEqual([{ rank: 10_000, targetName: "A" }]);

    for (const header of ["CHOICE #10001", "CHOICE #2147483648", "CHOICE #0"]) {
      const result = parseRankingList(sheetOf(writeSheet(["FULL_NAME", "CHOICE #1", header], [["Ann Lee", "A", "B"]])));
      expect(result.rows).toEqual([]);
      expect(result.errors).toEqual([
        { row: null, message: `Choice columns must be numbered 1 to 10,000. Rename or remove "${header}" and upload the file again.` },
      ]);
    }
    const parsed = parseImportFile("buyer_hotel_rankings", writeSheet(["FULL_NAME", "CHOICE #99999"], [["Ann Lee", "A"]]));
    expect(parsed.ok && isStructuralFailure(parsed.parsed)).toBe(true);
  });
});

describe("parseRankingMatrix", () => {
  it("reads ranks, N/A as rejection, and blanks as unranked", () => {
    const sheet = sheetOf(
      writeSheet(
        ["", "Hyatt Regency Monterey", "Visit SLO CAL", "eShow"],
        [
          ["HelmsBriscoe - Director", 2, "N/A", ""],
          ["Acme - VP", "", 1, "soon"],
        ],
      ),
    );
    const result = parseRankingMatrix(sheet);
    expect(result.rows).toEqual([
      {
        row: 2,
        rankerName: "HelmsBriscoe - Director",
        cells: [
          { targetName: "Hyatt Regency Monterey", rank: 2, isRejection: false },
          { targetName: "Visit SLO CAL", rank: null, isRejection: true },
          { targetName: "eShow", rank: null, isRejection: false },
        ],
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3);
    expect(result.errors[0].message).toContain('eShow="soon"');
  });

  it("accepts ranks up to 10,000 written as plain digits and refuses anything else", () => {
    const sheet = sheetOf(
      writeSheet(
        ["", "Hotel A", "Hotel B"],
        [
          ["Fits", "10000", "007"],
          ["Too big", "2147483648", "1"],
          ["Exponent", "1e3", "1"],
          ["Hex", "0x10", "1"],
          ["Zero", "0", "1"],
          ["Fraction", "2.5", "1"],
          ["Signed", "+3", "1"],
          ["Over", "10001", "1"],
        ],
      ),
    );
    const result = parseRankingMatrix(sheet);
    expect(result.rows).toEqual([
      {
        row: 2,
        rankerName: "Fits",
        cells: [
          { targetName: "Hotel A", rank: 10_000, isRejection: false },
          { targetName: "Hotel B", rank: 7, isRejection: false },
        ],
      },
    ]);
    expect(result.errors.map((e) => e.row)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(result.errors[0].message).toBe(
      'Too big: cells must be a whole number from 1 to 10,000, N/A, or blank (Hotel A="2147483648").',
    );
  });

  it("reads a \"__proto__\" or \"constructor\" column like any other name", () => {
    const sheet = sheetOf(writeSheet(["", "__proto__", "constructor"], [["Ann Lee", 1, "N/A"]]));
    const result = parseRankingMatrix(sheet);
    expect(result.errors).toEqual([]);
    expect(result.rows[0].cells).toEqual([
      { targetName: "__proto__", rank: 1, isRejection: false },
      { targetName: "constructor", rank: null, isRejection: true },
    ]);
  });
});

describe("parseImportFile", () => {
  it("routes ranking kinds by detected format and fails cleanly on garbage", () => {
    const list = parseImportFile("buyer_hotel_rankings", writeSheet(["FULL_NAME", "CHOICE #1"], [["Ann Lee", "Hotel"]]));
    expect(list.ok && list.parsed.format).toBe("list");
    const matrix = parseImportFile("supplier_rankings", writeSheet(["", "Ann Lee", "Bob Ray"], [["Hotel", 1, ""]]));
    expect(matrix.ok && matrix.parsed.format).toBe("matrix");
    const unknown = parseImportFile("buyer_hotel_rankings", writeSheet(["Email", "First name"], [["a@b.co", "A"]]));
    expect(unknown.ok).toBe(false);
    // SheetJS reads arbitrary text as a csv; the parser then finds no usable columns.
    const garbage = parseImportFile("participants", Buffer.from("not a spreadsheet\nat all"));
    expect(garbage.ok && isStructuralFailure(garbage.parsed)).toBe(true);
    // A header with no rows, and control bytes alone (stripped so they can be stored), are refused.
    const noRows = { ok: false, message: "The file has no rows.", refuse: true };
    expect(parseImportFile("participants", Buffer.from("not a spreadsheet"))).toEqual(noRows);
    expect(parseImportFile("participants", Buffer.from([1, 2, 3]))).toEqual(noRows);
    expect(parseImportFile("participants", writeSheet([], []))).toEqual(noRows);
  });

  it("template workbooks have one example row that parses on their own card", () => {
    const kinds = ["participants", "suppliers", "buyer_biztech_rankings", "buyer_hotel_rankings", "supplier_rankings"] as const;
    for (const kind of kinds) {
      const parsed = parseImportFile(kind, templateWorkbook(kind));
      expect(parsed.ok && parsed.parsed.errors).toEqual([]);
      expect(parsed.ok && parsed.parsed.rows).toHaveLength(1);
    }
    const hotel = readSheetRows(templateWorkbook("buyer_hotel_rankings"))[0];
    expect(detectFormat(hotel.headers)).toBe("list");
    // The three ranking templates differ: who ranks, and what the choices name.
    const sheets = kinds.slice(2).map((kind) => readSheetRows(templateWorkbook(kind))[0]);
    expect(new Set(sheets.map((sheet) => JSON.stringify([sheet.sheetName, sheet.rows]))).size).toBe(3);
    const supplier = sheets[2];
    expect(supplier.headers.slice(0, 2)).toEqual(["SUPPLIER", "EMAIL"]);
    expect(supplier.headers).not.toContain("FIRST_NAME");
    const list = parseRankingList(supplier);
    expect(list.rows[0]).toMatchObject({ rankerName: "Example Bay Hotel", rankerEmail: "sam.lee@example.com" });
    // A participants file with Organization and Category also fits the suppliers shape (name, type):
    // ambiguous, so it isn't refused on the Participants card.
    const overlap = ["Email", "First name", "Last name", "Organization", "Title", "Category"];
    expect(detectShape(overlap)).toBeNull();
    const overlapFile = writeSheet(overlap, [["jane.doe@example.com", "Jane", "Doe", "Example Meetings Co", "Planner", "Association"]]);
    expect(parseImportFile("participants", overlapFile, "participants.xlsx")).toMatchObject({ ok: true });
    expect(detectShape(["Name", "Type", "Admin contact email"])).toBe("suppliers");
    expect(detectShape(["Email", "First name", "Last name", "Organization"])).toBe("participants");
    // A template on the wrong card is refused.
    expect(parseImportFile("participants", templateWorkbook("supplier_rankings"), "AW_supplier_rankings_template.xlsx")).toEqual({
      ok: false,
      message: "This looks like a rankings file. Upload it on the Supplier rankings card.",
      refuse: true,
    });
  });
});
