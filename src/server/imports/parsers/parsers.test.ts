import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSheetRows, writeSheet } from "@/lib/xlsx";
import { detectFormat, templateWorkbook } from "../templates";
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
});

describe("parseImportFile", () => {
  it("routes ranking kinds by detected format and fails cleanly on garbage", () => {
    const list = parseImportFile("buyer_hotel_rankings", writeSheet(["FULL_NAME", "CHOICE #1"], [["Ann Lee", "Hotel"]]));
    expect(list.ok && list.parsed.format).toBe("list");
    const matrix = parseImportFile("supplier_rankings", writeSheet(["", "Ann Lee", "Bob Ray"], [["Hotel", 1, ""]]));
    expect(matrix.ok && matrix.parsed.format).toBe("matrix");
    const unknown = parseImportFile("buyer_hotel_rankings", writeSheet(["Email", "First name"], [["a@b.co", "A"]]));
    expect(unknown.ok).toBe(false);
    // SheetJS reads arbitrary bytes as a one-cell csv; the parser then finds no usable columns.
    const garbage = parseImportFile("participants", Buffer.from([1, 2, 3]));
    expect(garbage.ok && isStructuralFailure(garbage.parsed)).toBe(true);
    const empty = parseImportFile("participants", writeSheet([], []));
    expect(empty).toEqual({ ok: false, message: "The file has no rows." });
  });

  it("template workbooks parse with their own parser", () => {
    const participants = parseImportFile("participants", templateWorkbook("participants"));
    expect(participants.ok && participants.parsed.rows).toEqual([]);
    const rankings = readSheetRows(templateWorkbook("buyer_hotel_rankings"))[0];
    expect(detectFormat(rankings.headers)).toBe("list");
  });
});
