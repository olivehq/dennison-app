import { compareNames } from "@/lib/names";
import { deskLabel, toCsv, type ExportView } from "./common";

/** Output spec section 2, columns in this order. */
export const MASTER_COLUMNS = [
  "Slot",
  "Start Time",
  "End Time",
  "Buyer",
  "Supplier",
  "Desk",
  "Buyer Rank",
  "Supplier Rank",
] as const;

export type MasterRow = {
  slot: number;
  start: string;
  end: string;
  buyer: string;
  supplier: string;
  desk: string;
  /** Blank when the buyer did not rank the supplier. */
  buyerRank: number | "";
  supplierRank: number | "";
};

/** Every appointment of the view, sorted by slot then buyer name. */
export function masterScheduleRows(view: ExportView): MasterRow[] {
  const slots = new Map(view.slots.map((s) => [s.slot, s]));
  const buyers = new Map(view.buyers.map((b) => [b.id, b]));
  const suppliers = new Map(view.suppliers.map((s) => [s.id, s]));
  return view.appointments
    .map((a) => {
      const supplier = suppliers.get(a.supplierId);
      const supplierName = supplier?.name ?? "Unknown supplier";
      return {
        slot: a.slot,
        start: slots.get(a.slot)?.start ?? "",
        end: slots.get(a.slot)?.end ?? "",
        buyer: buyers.get(a.buyerId)?.name ?? "Unknown buyer",
        supplier: supplierName,
        desk: deskLabel(supplier?.desk ?? null, supplierName),
        buyerRank: a.buyerRank ?? "",
        supplierRank: a.supplierRank ?? "",
      } satisfies MasterRow;
    })
    .sort((a, b) => a.slot - b.slot || compareNames(a.buyer, b.buyer) || compareNames(a.supplier, b.supplier));
}

/** `Master_Schedule_<year>_Final.csv`. */
export function masterScheduleCsv(view: ExportView): string {
  return toCsv(
    [...MASTER_COLUMNS],
    masterScheduleRows(view).map((r) => [
      r.slot,
      r.start,
      r.end,
      r.buyer,
      r.supplier,
      r.desk,
      r.buyerRank,
      r.supplierRank,
    ]),
  );
}
