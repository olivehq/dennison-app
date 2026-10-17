import { ZipArchive, type Archiver } from "archiver";
import { compareNames } from "@/lib/names";
import { participantSlots } from "@/server/schedule/snapshot";
import { deskLabel, toCsv, type ExportView } from "./common";
import { scheduleFilename, uniqueFilenames } from "./filenames";
import { NO_LINK, personLinkKey, type LinkRow, type PersonLinkRows } from "./links";

/**
 * Per-person schedule CSVs and the ZIP that holds them (output spec section
 * 1). Every file has one row per slot, with OPEN where there is no
 * appointment, and no ranking columns. Under the slots, one row per contact
 * holds that contact's schedule link, or says why there is none.
 */

export const OPEN = "OPEN";
export const BUYER_COLUMNS = ["Start Time", "End Time", "Slot", "Desk - Supplier Name"];
export const SUPPLIER_COLUMNS = ["Start Time", "End Time", "Slot", "Buyer Name"];

/** One slot of a person's file: what the participant page shows (`participantSlots`). */
export type ExportPersonSlot = {
  slot: number;
  start: string;
  end: string;
  appointment: { counterpartName: string; desk: number | null } | null;
};

export type ExportPerson = { name: string; slots: ExportPersonSlot[]; links: LinkRow[] };

/** The label in the first cell and the link (or the reason there is none) in the second. */
function linkRows(person: Pick<ExportPerson, "links">): string[][] {
  const links = person.links.length > 0 ? person.links : [{ label: "Schedule link", value: NO_LINK }];
  return links.map((l) => [l.label, l.value, "", ""]);
}

export function buyerScheduleCsv(person: Pick<ExportPerson, "slots" | "links">): string {
  return toCsv(BUYER_COLUMNS, [
    ...person.slots.map((s) => [
      s.start,
      s.end,
      s.slot,
      s.appointment ? deskLabel(s.appointment.desk, s.appointment.counterpartName) : OPEN,
    ]),
    ...linkRows(person),
  ]);
}

export function supplierScheduleCsv(person: Pick<ExportPerson, "slots" | "links">): string {
  return toCsv(SUPPLIER_COLUMNS, [
    ...person.slots.map((s) => [s.start, s.end, s.slot, s.appointment ? s.appointment.counterpartName : OPEN]),
    ...linkRows(person),
  ]);
}

/**
 * Every active buyer's and supplier's slots, built from one view so the ZIP
 * needs one query instead of one per person. Withdrawn people get no file
 * (D42), and each file shows what the participant page shows: a meeting with
 * someone who withdrew is OPEN (D96).
 */
export function personSchedulesFromView(
  view: ExportView,
  links: PersonLinkRows,
): { buyers: ExportPerson[]; suppliers: ExportPerson[] } {
  const buyers = view.buyers
    .filter((b) => !b.withdrawn)
    .map((b) => ({
      name: b.name,
      links: links.get(personLinkKey("buyer", b.id)) ?? [],
      slots: participantSlots(view, { type: "buyer", id: b.id }),
    }))
    .sort((x, y) => compareNames(x.name, y.name));

  const suppliers = view.suppliers
    .filter((s) => !s.withdrawn)
    .map((s) => ({
      name: s.name,
      links: links.get(personLinkKey("supplier", s.id)) ?? [],
      slots: participantSlots(view, { type: "supplier", id: s.id }),
    }))
    .sort((x, y) => compareNames(x.name, y.name));

  return { buyers, suppliers };
}

export type ZipEntry = { path: string; csv: string };

/** The ZIP's files: `buyer_schedules/Buyer_Schedule_<name>.csv` and `supplier_schedules/Supplier_Schedule_<name>.csv`. */
export function scheduleZipEntries(view: ExportView, links: PersonLinkRows): ZipEntry[] {
  const { buyers, suppliers } = personSchedulesFromView(view, links);
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
export function schedulesZip(view: ExportView, links: PersonLinkRows): Archiver {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const date = new Date();
  for (const entry of scheduleZipEntries(view, links)) {
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
