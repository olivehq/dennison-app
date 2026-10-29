import { IMPORT_KIND_LABELS, isRankingKind, type ImportKind, type RankingKind } from "@/lib/schemas/import";
import { readSheetRows, SpreadsheetTooLargeError, type SheetRows } from "@/lib/xlsx";
import { detectFormat, detectShape } from "../templates";
import { parseParticipants } from "./participants";
import { parseRankingList } from "./ranking-list";
import { parseRankingMatrix } from "./ranking-matrix";
import { parseSuppliers } from "./suppliers";
import type { ParsedFile } from "./types";

/**
 * `refuse` marks a file that isn't worth keeping as a failed import: it is
 * empty or belongs on another card. The upload is refused with the message.
 */
export type ParseOutcome = { ok: true; parsed: ParsedFile } | { ok: false; message: string; refuse?: boolean };

/** The first sheet with a header row and at least one data row, else the first with a header. */
function pickSheet(sheets: SheetRows[]): SheetRows | null {
  return sheets.find((sheet) => sheet.rows.length > 0) ?? sheets[0] ?? null;
}

const NO_ROWS = "The file has no rows.";

function readWorkbook(buffer: Buffer | Uint8Array): SheetRows | { message: string; refuse?: boolean } {
  let sheets: SheetRows[];
  try {
    sheets = readSheetRows(buffer);
  } catch (error) {
    if (error instanceof SpreadsheetTooLargeError) return { message: error.message };
    const detail = error instanceof Error ? error.message : String(error);
    return { message: `Could not read the file as a spreadsheet (${detail}).` };
  }
  const sheet = pickSheet(sheets);
  if (!sheet || sheet.rows.length === 0) return { message: NO_ROWS, refuse: true };
  return sheet;
}

/** The ranking card a file name points at ("…hotel_rankings…"), or null when it doesn't say. */
export function rankingKindFromFileName(fileName: string): RankingKind | null {
  const name = fileName.toLowerCase();
  if (/supplier[\s_-]*rank/.test(name)) return "supplier_rankings";
  if (name.includes("hotel")) return "buyer_hotel_rankings";
  if (/biz|business|tech/.test(name)) return "buyer_biztech_rankings";
  return null;
}

/** Null when the headers fit the card; otherwise where the file should go. */
function wrongCardMessage(kind: ImportKind, headers: string[], fileName: string): string | null {
  const shape = detectShape(headers);
  if (shape === null || shape === (isRankingKind(kind) ? "rankings" : kind)) return null;
  if (shape !== "rankings") {
    return `This looks like a ${shape} file. Upload it on the ${IMPORT_KIND_LABELS[shape]} card.`;
  }
  const guess = rankingKindFromFileName(fileName);
  return guess
    ? `This looks like a rankings file. Upload it on the ${IMPORT_KIND_LABELS[guess]} card.`
    : `This looks like a rankings file. Upload it on the ${IMPORT_KIND_LABELS.buyer_biztech_rankings}, ${IMPORT_KIND_LABELS.buyer_hotel_rankings}, or ${IMPORT_KIND_LABELS.supplier_rankings} card.`;
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

/**
 * Opens the workbook, picks the sheet, refuses a file with no rows or one
 * shaped for another card, detects the format for ranking kinds, and parses.
 * `fileName` only helps name the right card.
 */
export function parseImportFile(kind: ImportKind, buffer: Buffer | Uint8Array, fileName = ""): ParseOutcome {
  const sheet = readWorkbook(buffer);
  if ("message" in sheet) return { ok: false, message: sheet.message, refuse: sheet.refuse };
  const wrongCard = wrongCardMessage(kind, sheet.headers, fileName);
  if (wrongCard) return { ok: false, message: wrongCard, refuse: true };
  return parseSheet(kind, sheet);
}

export { parseParticipants, parseRankingList, parseRankingMatrix, parseSuppliers };
export type * from "./types";
