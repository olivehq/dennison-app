import type { SheetRows } from "@/lib/xlsx";
import type { MatrixCell, ParsedRankingMatrixRow, ParsedRows } from "./types";

const REJECTION = new Set(["n/a", "na", "n.a.", "x", "no", "never"]);

type CellValue = { rank: number | null; isRejection: boolean } | null;

function parseCell(value: string): CellValue {
  const text = value.trim();
  if (text === "") return { rank: null, isRejection: false };
  if (REJECTION.has(text.toLowerCase())) return { rank: null, isRejection: true };
  const number = Number(text);
  if (Number.isInteger(number) && number >= 1) return { rank: number, isRejection: false };
  return null;
}

/**
 * 2025 matrix: rows are rankers, columns are the ranked entities, cells hold a
 * rank, N/A, or nothing (D18). N/A is a rejection; blank is unranked (D2).
 */
export function parseRankingMatrix(sheet: SheetRows): ParsedRows<ParsedRankingMatrixRow> {
  const [nameHeader, ...targetHeaders] = sheet.headers;
  if (nameHeader === undefined || targetHeaders.length === 0) {
    return { rows: [], errors: [{ row: null, message: "The matrix needs a name column and at least one entity column." }] };
  }
  const rows: ParsedRankingMatrixRow[] = [];
  const errors: ParsedRows<ParsedRankingMatrixRow>["errors"] = [];
  sheet.rows.forEach((record, index) => {
    const row = sheet.rowNumbers[index];
    const rankerName = record[nameHeader] ?? "";
    if (rankerName === "") {
      errors.push({ row, message: "Row has no name in the first column." });
      return;
    }
    const cells: MatrixCell[] = [];
    const bad: string[] = [];
    for (const header of targetHeaders) {
      const parsed = parseCell(record[header] ?? "");
      if (!parsed) {
        bad.push(`${header}="${record[header]}"`);
        continue;
      }
      cells.push({ targetName: header, ...parsed });
    }
    if (bad.length > 0) {
      errors.push({
        row,
        message: `${rankerName}: cells must be a number, N/A, or blank (${bad.join(", ")}).`,
      });
      return;
    }
    rows.push({ row, rankerName, cells });
  });
  return { rows, errors };
}
