import type { ImportKind } from "@/lib/schemas/import";
import { readSheetRows, type SheetRows } from "@/lib/xlsx";
import { detectFormat } from "../templates";
import { parseParticipants } from "./participants";
import { parseRankingList } from "./ranking-list";
import { parseRankingMatrix } from "./ranking-matrix";
import { parseSuppliers } from "./suppliers";
import type { ParsedFile } from "./types";

export type ParseOutcome = { ok: true; parsed: ParsedFile } | { ok: false; message: string };

/** The first sheet with a header row and at least one data row, else the first with a header. */
function pickSheet(sheets: SheetRows[]): SheetRows | null {
  return sheets.find((sheet) => sheet.rows.length > 0) ?? sheets[0] ?? null;
}

function readWorkbook(buffer: Buffer | Uint8Array): SheetRows | { message: string } {
  let sheets: SheetRows[];
  try {
    sheets = readSheetRows(buffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { message: `Could not read the file as a spreadsheet (${detail}).` };
  }
  const sheet = pickSheet(sheets);
  if (!sheet) return { message: "The file has no rows." };
  return sheet;
}

function parseSheet(kind: ImportKind, sheet: SheetRows): ParseOutcome {
  if (kind === "participants") {
    return { ok: true, parsed: { kind, format: "template", ...parseParticipants(sheet) } };
  }
  if (kind === "suppliers") {
    return { ok: true, parsed: { kind, format: "template", ...parseSuppliers(sheet) } };
  }
  const format = detectFormat(sheet.headers);
  if (format === "list") {
    return { ok: true, parsed: { kind: "ranking", format, ...parseRankingList(sheet) } };
  }
  if (format === "matrix") {
    return { ok: true, parsed: { kind: "ranking", format, ...parseRankingMatrix(sheet) } };
  }
  return {
    ok: false,
    message:
      "Could not recognise the ranking format. Expected CHOICE #1..#N columns (eShow list) or a name column followed by one column per entity (2025 matrix).",
  };
}

/**
 * True when the parser could not use the file at all: no rows and a file-level
 * error (missing columns, unknown layout). Such an import is stored as failed.
 */
export function isStructuralFailure(parsed: ParsedFile): boolean {
  return parsed.rows.length === 0 && parsed.errors.some((error) => error.row === null);
}

/** Opens the workbook, picks the sheet, detects the format for ranking kinds, and parses. */
export function parseImportFile(kind: ImportKind, buffer: Buffer | Uint8Array): ParseOutcome {
  const sheet = readWorkbook(buffer);
  if ("message" in sheet) return { ok: false, message: sheet.message };
  return parseSheet(kind, sheet);
}

export { parseParticipants, parseRankingList, parseRankingMatrix, parseSuppliers };
export type * from "./types";
