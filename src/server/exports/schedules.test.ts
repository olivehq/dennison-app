import { describe, expect, it } from "vitest";
import { BOM, type ExportView } from "./common";
import {
  buyerScheduleCsv,
  personSchedulesFromView,
  scheduleZipEntries,
  schedulesZip,
  supplierScheduleCsv,
  toWebStream,
} from "./schedules";
import { smallView } from "./test-view";

function lines(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true);
  return csv.slice(1).trimEnd().split("\n");
}

describe("person schedule CSVs", () => {
  const { buyers, suppliers } = personSchedulesFromView(smallView);

  it("builds files for active people only, sorted by name", () => {
    expect(buyers.map((b) => b.name)).toEqual(["Acme, Inc - Director", "Zed Org - Planner"]);
    expect(suppliers.map((s) => s.name)).toEqual(["eShow", "Hilton Irvine/Orange County Airport"]);
  });

  it("gives a buyer every slot with desk and supplier, OPEN when empty", () => {
    expect(lines(buyerScheduleCsv(buyers[0]))).toEqual([
      "Start Time,End Time,Slot,Desk - Supplier Name",
      "3:10 PM,3:20 PM,1,Desk 12 - Hilton Irvine/Orange County Airport",
      "3:21 PM,3:31 PM,2,OPEN",
      "3:32 PM,3:42 PM,3,eShow",
    ]);
  });

  it("gives a supplier every slot with the buyer name, OPEN when empty", () => {
    expect(lines(supplierScheduleCsv(suppliers[1]))).toEqual([
      "Start Time,End Time,Slot,Buyer Name",
      '3:10 PM,3:20 PM,1,"Acme, Inc - Director"',
      "3:21 PM,3:31 PM,2,Zed Org - Planner",
      "3:32 PM,3:42 PM,3,OPEN",
    ]);
  });

  it("never prints ranks", () => {
    for (const entry of scheduleZipEntries(smallView)) {
      expect(entry.csv).not.toMatch(/rank/i);
      expect(lines(entry.csv)).toHaveLength(smallView.slots.length + 1);
    }
  });
});

describe("appointments with someone who withdrew", () => {
  // Gone Org (withdrawn buyer) still holds slot 3 at the Hilton, and a
  // withdrawn supplier still holds slot 2 with Acme: both slots are OPEN.
  const view: ExportView = {
    ...smallView,
    suppliers: [...smallView.suppliers, { id: "s-gone", name: "Gone Hotel", desk: 14, withdrawn: true }],
    appointments: [
      ...smallView.appointments,
      { slot: 3, buyerId: "b-gone", supplierId: "s-hotel", buyerRank: 2, supplierRank: 3 },
      { slot: 2, buyerId: "b-acme", supplierId: "s-gone", buyerRank: 4, supplierRank: 5 },
    ],
  };

  it("shows them as OPEN in the buyer and supplier files", () => {
    const { buyers, suppliers } = personSchedulesFromView(view);
    expect(buyers.map((b) => b.name)).toEqual(["Acme, Inc - Director", "Zed Org - Planner"]);
    expect(suppliers.map((s) => s.name)).toEqual(["eShow", "Hilton Irvine/Orange County Airport"]);
    expect(lines(buyerScheduleCsv(buyers[0]))[2]).toBe("3:21 PM,3:31 PM,2,OPEN");
    expect(lines(supplierScheduleCsv(suppliers[1]))[3]).toBe("3:32 PM,3:42 PM,3,OPEN");
    const csvs = scheduleZipEntries(view).map((e) => e.csv).join("\n");
    expect(csvs).not.toContain("Gone");
  });
});

describe("schedulesZip", () => {
  it("streams one entry per active person under the two folders", async () => {
    const archive = schedulesZip(smallView);
    const names: string[] = [];
    archive.on("entry", (entry) => names.push(entry.name));
    const chunks: Uint8Array[] = [];
    const reader = toWebStream(archive).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const zip = Buffer.concat(chunks);
    // Local file header signature, and the end of central directory record at the tail.
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    expect(zip.readUInt16LE(eocd + 10)).toBe(4);
    expect(names.sort()).toEqual([
      "buyer_schedules/Buyer_Schedule_Acme Inc - Director.csv",
      "buyer_schedules/Buyer_Schedule_Zed Org - Planner.csv",
      "supplier_schedules/Supplier_Schedule_Hilton Irvine_Orange County Airport.csv",
      "supplier_schedules/Supplier_Schedule_eShow.csv",
    ]);
  });
});
