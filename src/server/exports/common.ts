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

/**
 * CSV text with a header row. Starts with a UTF-8 byte order mark so Excel,
 * which D&A opens these in, reads accented names correctly.
 */
export function toCsv(columns: string[], rows: (string | number)[][]): string {
  return stringify(rows, { header: true, columns, bom: true });
}

export const BOM = "﻿";
