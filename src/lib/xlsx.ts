import * as XLSX from "xlsx";

export type SheetRows = {
  sheetName: string;
  /** Trimmed header cells in column order. Blank headers stay "" so matrix files keep their first column. */
  headers: string[];
  /** One record per non-empty data row, keyed by header. Every value is a trimmed string. */
  rows: Record<string, string>[];
  /** 1-based spreadsheet row number for each entry in `rows`, for error messages. */
  rowNumbers: number[];
};

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/** Two columns with the same header would overwrite each other; the later one gets a suffix. */
function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count === 0 ? header : `${header} (${count + 1})`;
  });
}

function sheetToRows(sheetName: string, sheet: XLSX.WorkSheet): SheetRows | null {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
  });
  const headerIndex = grid.findIndex((row) => row.some((cell) => cellToString(cell) !== ""));
  if (headerIndex === -1) return null;

  const rawHeaders = grid[headerIndex].map(cellToString);
  // Drop trailing blank header columns; they carry no data.
  let width = rawHeaders.length;
  while (width > 0 && rawHeaders[width - 1] === "") width -= 1;
  const headers = uniqueHeaders(rawHeaders.slice(0, width));

  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  grid.slice(headerIndex + 1).forEach((line, offset) => {
    const cells = headers.map((_, column) => cellToString(line[column]));
    if (cells.every((cell) => cell === "")) return;
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      record[header] = cells[column];
    });
    rows.push(record);
    rowNumbers.push(headerIndex + offset + 2);
  });
  return { sheetName, headers, rows, rowNumbers };
}

/**
 * Reads every sheet of an xlsx, xls, or csv file. Cells are trimmed strings,
 * fully empty rows are dropped, and sheets with no content are omitted.
 * Throws when the buffer is not a workbook SheetJS can open.
 */
export function readSheetRows(buffer: Buffer | Uint8Array): SheetRows[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheets: SheetRows[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const parsed = sheetToRows(sheetName, sheet);
    if (parsed) sheets.push(parsed);
  }
  return sheets;
}

export type SheetInputRow = Record<string, string | number | null | undefined> | (string | number | null)[];

/** Builds a one-sheet xlsx. Rows may be records keyed by header or positional arrays. */
export function writeSheet(
  headers: string[],
  rows: SheetInputRow[],
  sheetName = "Sheet1",
): Buffer {
  const grid: (string | number)[][] = [headers];
  for (const row of rows) {
    if (Array.isArray(row)) {
      grid.push(headers.map((_, index) => row[index] ?? ""));
    } else {
      grid.push(headers.map((header) => row[header] ?? ""));
    }
  }
  const sheet = XLSX.utils.aoa_to_sheet(grid);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  const out: unknown = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(out as Uint8Array);
}
