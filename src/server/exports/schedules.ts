import { ZipArchive, type Archiver } from "archiver";
import { compareNames } from "@/lib/names";
import { deskLabel, toCsv, type ExportView } from "./common";
import { scheduleFilename, uniqueFilenames } from "./filenames";

/**
 * Per-person schedule CSVs and the ZIP that holds them (output spec section
 * 1). Every file has one row per slot, with OPEN where there is no
 * appointment, and no ranking columns.
 */

export const OPEN = "OPEN";
export const BUYER_COLUMNS = ["Start Time", "End Time", "Slot", "Desk - Supplier Name"];
export const SUPPLIER_COLUMNS = ["Start Time", "End Time", "Slot", "Buyer Name"];

/** Same shape as `PersonSchedule.slots` from `getPersonSchedule`, minus what the files do not print. */
export type ExportPersonSlot = {
  slot: number;
  start: string;
  end: string;
  appointment: { counterpartName: string; desk: number | null } | null;
};

export type ExportPerson = { name: string; slots: ExportPersonSlot[] };

export function buyerScheduleCsv(person: Pick<ExportPerson, "slots">): string {
  return toCsv(
    BUYER_COLUMNS,
    person.slots.map((s) => [
      s.start,
      s.end,
      s.slot,
      s.appointment ? deskLabel(s.appointment.desk, s.appointment.counterpartName) : OPEN,
    ]),
  );
}

export function supplierScheduleCsv(person: Pick<ExportPerson, "slots">): string {
  return toCsv(
    SUPPLIER_COLUMNS,
    person.slots.map((s) => [s.start, s.end, s.slot, s.appointment ? s.appointment.counterpartName : OPEN]),
  );
}

/**
 * Every active buyer's and supplier's slots, built from one view so the ZIP
 * needs one query instead of one per person. Withdrawn people get no file,
 * and an appointment with someone who withdrew is OPEN on the other side's
 * file, as on the participant page (D87).
 */
export function personSchedulesFromView(view: ExportView): { buyers: ExportPerson[]; suppliers: ExportPerson[] } {
  const buyerNames = new Map(view.buyers.map((b) => [b.id, b.name]));
  const suppliers = new Map(view.suppliers.map((s) => [s.id, s]));
  const withdrawn = new Set([...view.buyers, ...view.suppliers].filter((p) => p.withdrawn).map((p) => p.id));
  const byBuyer = new Map<string, Map<number, ExportView["appointments"][number]>>();
  const bySupplier = new Map<string, Map<number, ExportView["appointments"][number]>>();
  for (const a of view.appointments) {
    if (withdrawn.has(a.buyerId) || withdrawn.has(a.supplierId)) continue;
    if (!byBuyer.has(a.buyerId)) byBuyer.set(a.buyerId, new Map());
    if (!bySupplier.has(a.supplierId)) bySupplier.set(a.supplierId, new Map());
    byBuyer.get(a.buyerId)!.set(a.slot, a);
    bySupplier.get(a.supplierId)!.set(a.slot, a);
  }

  const buyers = view.buyers
    .filter((b) => !b.withdrawn)
    .map((b) => ({
      name: b.name,
      slots: view.slots.map((s) => {
        const a = byBuyer.get(b.id)?.get(s.slot);
        const supplier = a ? suppliers.get(a.supplierId) : undefined;
        return {
          slot: s.slot,
          start: s.start,
          end: s.end,
          appointment: a ? { counterpartName: supplier?.name ?? "Unknown supplier", desk: supplier?.desk ?? null } : null,
        };
      }),
    }))
    .sort((x, y) => compareNames(x.name, y.name));

  const supplierPeople = view.suppliers
    .filter((s) => !s.withdrawn)
    .map((sup) => ({
      name: sup.name,
      slots: view.slots.map((s) => {
        const a = bySupplier.get(sup.id)?.get(s.slot);
        return {
          slot: s.slot,
          start: s.start,
          end: s.end,
          appointment: a ? { counterpartName: buyerNames.get(a.buyerId) ?? "Unknown buyer", desk: sup.desk } : null,
        };
      }),
    }))
    .sort((x, y) => compareNames(x.name, y.name));

  return { buyers, suppliers: supplierPeople };
}

export type ZipEntry = { path: string; csv: string };

/** The ZIP's files: `buyer_schedules/Buyer_Schedule_<name>.csv` and `supplier_schedules/Supplier_Schedule_<name>.csv`. */
export function scheduleZipEntries(view: ExportView): ZipEntry[] {
  const { buyers, suppliers } = personSchedulesFromView(view);
  const buyerFiles = uniqueFilenames(buyers.map((b) => scheduleFilename("Buyer_Schedule_", b.name)));
  const supplierFiles = uniqueFilenames(suppliers.map((s) => scheduleFilename("Supplier_Schedule_", s.name)));
  return [
    ...buyers.map((b, i) => ({ path: `buyer_schedules/${buyerFiles[i]}`, csv: buyerScheduleCsv(b) })),
    ...suppliers.map((s, i) => ({ path: `supplier_schedules/${supplierFiles[i]}`, csv: supplierScheduleCsv(s) })),
  ];
}

/**
 * `AW_<year>_Schedules.zip` as a streaming archive. Nothing is buffered:
 * bytes flow as the consumer reads. Errors surface as the stream's `error`
 * event.
 */
export function schedulesZip(view: ExportView): Archiver {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const date = new Date();
  for (const entry of scheduleZipEntries(view)) {
    archive.append(entry.csv, { name: entry.path, date });
  }
  // finalize() rejects with the same error the stream emits; the consumer handles it there.
  archive.finalize().catch(() => {});
  return archive;
}

/** Adapts a Node readable (archiver) to the web stream a Route Handler returns, with backpressure. */
export function toWebStream(source: AsyncIterable<Buffer | Uint8Array | string>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
