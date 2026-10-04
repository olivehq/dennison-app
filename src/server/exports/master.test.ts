import { describe, expect, it } from "vitest";
import { BOM } from "./common";
import { masterScheduleCsv, masterScheduleRows } from "./master";
import { smallView } from "./test-view";

describe("masterScheduleRows", () => {
  it("sorts by slot then buyer and formats desk and blank ranks", () => {
    const rows = masterScheduleRows(smallView);
    expect(rows.map((r) => [r.slot, r.buyer])).toEqual([
      [1, "Acme, Inc - Director"],
      [1, "Zed Org - Planner"],
      [2, "Zed Org - Planner"],
      [3, "Acme, Inc - Director"],
    ]);
    expect(rows[0]).toEqual({
      slot: 1,
      start: "3:10 PM",
      end: "3:20 PM",
      buyer: "Acme, Inc - Director",
      supplier: "Hilton Irvine/Orange County Airport",
      desk: "Desk 12 - Hilton Irvine/Orange County Airport",
      buyerRank: 1,
      supplierRank: 1,
    });
    expect(rows[1]).toMatchObject({ desk: "eShow", buyerRank: "", supplierRank: 2 });
    expect(rows[3]).toMatchObject({ buyerRank: 7, supplierRank: "" });
  });
});

describe("masterScheduleCsv", () => {
  it("writes the spec's header and quotes values with commas", () => {
    const csv = masterScheduleCsv(smallView);
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Slot,Start Time,End Time,Buyer,Supplier,Desk,Buyer Rank,Supplier Rank");
    expect(lines[1]).toBe(
      '1,3:10 PM,3:20 PM,"Acme, Inc - Director",Hilton Irvine/Orange County Airport,Desk 12 - Hilton Irvine/Orange County Airport,1,1',
    );
    expect(lines[2]).toBe("1,3:10 PM,3:20 PM,Zed Org - Planner,eShow,eShow,,2");
  });
});
