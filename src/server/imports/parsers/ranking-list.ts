import type { SheetRows } from "@/lib/xlsx";
import { CHOICE_HEADER, rankingListColumns } from "../templates";
import { columnReader, MAX_RANK, parseEmail, parseRank } from "./shared";
import type { ParsedRankingListRow, ParsedRows, RankingChoice } from "./types";

type ChoiceColumn = { header: string; rank: number };

/** The CHOICE #n columns sorted by n, and the headers whose n is not a rank (0, or over `MAX_RANK`). */
export function choiceColumns(headers: string[]): { columns: ChoiceColumn[]; outOfRange: string[] } {
  const columns: ChoiceColumn[] = [];
  const outOfRange: string[] = [];
  for (const header of headers) {
    const match = CHOICE_HEADER.exec(header.trim());
    if (!match) continue;
    const rank = parseRank(match[1]);
    if (rank === null) outOfRange.push(header);
    else columns.push({ header, rank });
  }
  return { columns: columns.sort((a, b) => a.rank - b.rank), outOfRange };
}

/**
 * eShow attendee ratings export: FIRST_NAME, LAST_NAME, FULL_NAME, optional
 * EMAIL, then CHOICE #1..#N holding one name each. The column number is the
 * rank. Names absent from a row are unranked, never rejected (D2).
 */
export function parseRankingList(sheet: SheetRows): ParsedRows<ParsedRankingListRow> {
  const { columns, outOfRange } = choiceColumns(sheet.headers);
  if (outOfRange.length > 0) {
    const named = outOfRange.map((header) => `"${header}"`).join(", ");
    return {
      rows: [],
      errors: [
        {
          row: null,
          message: `Choice columns must be numbered 1 to ${MAX_RANK.toLocaleString("en")}. Rename or remove ${named} and upload the file again.`,
        },
      ],
    };
  }
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
