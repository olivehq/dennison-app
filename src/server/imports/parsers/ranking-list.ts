import type { SheetRows } from "@/lib/xlsx";
import { CHOICE_HEADER, rankingListColumns } from "../templates";
import { columnReader, parseEmail } from "./shared";
import type { ParsedRankingListRow, ParsedRows, RankingChoice } from "./types";

type ChoiceColumn = { header: string; rank: number };

export function choiceColumns(headers: string[]): ChoiceColumn[] {
  return headers
    .map((header) => {
      const match = CHOICE_HEADER.exec(header.trim());
      return match ? { header, rank: Number(match[1]) } : null;
    })
    .filter((column): column is ChoiceColumn => column !== null)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * eShow attendee ratings export: FIRST_NAME, LAST_NAME, FULL_NAME, optional
 * EMAIL, then CHOICE #1..#N holding one name each. The column number is the
 * rank. Names absent from a row are unranked, never rejected (D2).
 */
export function parseRankingList(sheet: SheetRows): ParsedRows<ParsedRankingListRow> {
  const columns = choiceColumns(sheet.headers);
  if (columns.length === 0) {
    return { rows: [], errors: [{ row: null, message: "No CHOICE #n columns found." }] };
  }
  const fullName = columnReader(sheet, rankingListColumns.fullName);
  const firstName = columnReader(sheet, rankingListColumns.firstName);
  const lastName = columnReader(sheet, rankingListColumns.lastName);
  const email = columnReader(sheet, rankingListColumns.email);
  if (!fullName && !(firstName && lastName)) {
    return {
      rows: [],
      errors: [{ row: null, message: "Missing a FULL_NAME column or FIRST_NAME and LAST_NAME columns." }],
    };
  }

  const rows: ParsedRankingListRow[] = [];
  const errors: ParsedRows<ParsedRankingListRow>["errors"] = [];
  sheet.rows.forEach((record, index) => {
    const row = sheet.rowNumbers[index];
    let name = fullName ? fullName(record) : "";
    if (name === "" && firstName && lastName) {
      name = `${firstName(record)} ${lastName(record)}`.trim();
    }
    const rawEmail = email ? email(record) : "";
    const rankerEmail = rawEmail === "" ? null : parseEmail(rawEmail);
    if (rawEmail !== "" && !rankerEmail) {
      errors.push({ row, message: `"${rawEmail}" is not a valid email address.` });
      return;
    }
    if (name === "" && !rankerEmail) {
      errors.push({ row, message: "Row has no name and no email." });
      return;
    }
    const choices: RankingChoice[] = [];
    for (const column of columns) {
      const value = record[column.header] ?? "";
      if (value !== "") choices.push({ rank: column.rank, targetName: value });
    }
    rows.push({ row, rankerName: name, rankerEmail, choices });
  });
  return { rows, errors };
}
