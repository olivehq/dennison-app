import { emailSchema } from "@/lib/schemas/roster";
import type { SheetRows } from "@/lib/xlsx";
import { findColumn, type TemplateColumn } from "../templates";

export type ColumnReader = (row: Record<string, string>) => string;

/** Returns a reader for the column, or null when no header matches. */
export function columnReader(sheet: SheetRows, column: TemplateColumn): ColumnReader | null {
  const index = findColumn(sheet.headers, column);
  if (index === -1) return null;
  const header = sheet.headers[index];
  return (row) => row[header] ?? "";
}

export function optionalReader(sheet: SheetRows, column: TemplateColumn): ColumnReader {
  return columnReader(sheet, column) ?? (() => "");
}

export function blankToNull(value: string): string | null {
  return value === "" ? null : value;
}

/** Lower-cased, trimmed email or null when the cell does not hold one. */
export function parseEmail(value: string): string | null {
  const parsed = emailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const YES = new Set(["yes", "y", "true", "1", "x", "opt-in", "opt in", "opted in"]);
const NO = new Set(["no", "n", "false", "0", "opt-out", "opt out", "opted out"]);

/** yes/no cell to boolean; blank is null (not provided); anything else is undefined (invalid). */
export function parseYesNo(value: string): boolean | null | undefined {
  const key = value.trim().toLowerCase();
  if (key === "") return null;
  if (YES.has(key)) return true;
  if (NO.has(key)) return false;
  return undefined;
}

export function missingColumnsMessage(columns: TemplateColumn[]): string {
  const names = columns.map((column) => `"${column.header}"`).join(", ");
  return `Missing required column${columns.length > 1 ? "s" : ""}: ${names}.`;
}
