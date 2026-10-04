import { stringify } from "csv-stringify/sync";
import type { ScheduleAppointment, ScheduleBuyer, ScheduleSlot, ScheduleSupplier } from "@/server/schedule/views";

/**
 * The slice of `ScheduleView` the export builders read. A full `ScheduleView`
 * satisfies it; tests build small ones by hand.
 */
export type ExportView = {
  slots: Pick<ScheduleSlot, "slot" | "start" | "end">[];
  buyers: Pick<ScheduleBuyer, "id" | "name" | "withdrawn">[];
  suppliers: Pick<ScheduleSupplier, "id" | "name" | "desk" | "withdrawn">[];
  appointments: Pick<ScheduleAppointment, "slot" | "buyerId" | "supplierId" | "buyerRank" | "supplierRank">[];
};

/** "Desk 12 - Supplier Name", or just the name before desks are assigned at lock (D17). */
export function deskLabel(desk: number | null, supplierName: string): string {
  return desk === null ? supplierName : `Desk ${desk} - ${supplierName}`;
}

/** The year in the export file names, from the event date ("2025-11-14" -> "2025"). */
export function eventYear(eventDate: string): string {
  return eventDate.slice(0, 4);
}

/** First characters that make Excel or Sheets read a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralises CSV formula injection: a text cell that starts like a formula
 * gets a leading single quote, so a name such as `=HYPERLINK(...)` shows as
 * text. Numbers are left alone.
 */
export function csvCell(value: string | number): string | number {
  return typeof value === "string" && FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * CSV text with a header row. Starts with a UTF-8 byte order mark so Excel,
 * which D&A opens these in, reads accented names correctly. Every export
 * writes through here, so every cell goes through `csvCell`.
 */
export function toCsv(columns: string[], rows: (string | number)[][]): string {
  return stringify(
    rows.map((row) => row.map(csvCell)),
    { header: true, columns: columns.map((c) => String(csvCell(c))), bom: true },
  );
}

export const BOM = "﻿";
