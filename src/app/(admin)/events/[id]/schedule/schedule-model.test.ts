import { describe, expect, it } from "vitest";
import type { ScheduleAppointment, ScheduleBuyer, ScheduleSupplier } from "@/server/schedule/queries";
import {
  attentionCount,
  buildModel,
  describeEdit,
  distribution,
  freeIn,
  healthOf,
  healthText,
  lanesFor,
  parseFree,
  parseView,
  personLabel,
  sheetRows,
} from "./schedule-model";

const TARGETS = { supplierTarget: 2, buyerMin: 1, buyerMax: 2 };

const supplier = (id: string, name: string, desk: number | null, count: number): ScheduleSupplier => ({
  id,
  name,
  type: "hotel",
  desk,
  count,
  withdrawn: false,
});
const buyer = (id: string, org: string, title: string, count: number, withdrawn = false): ScheduleBuyer => ({
  id,
  name: `${org} - ${title}`,
  organization: org,
  title,
  count,
  biztechOptIn: true,
  withdrawn,
});
const appt = (id: string, slot: number, buyerId: string, supplierId: string): ScheduleAppointment => ({
  id,
  slot,
  buyerId,
  supplierId,
  buyerRank: 1,
  supplierRank: 1,
  source: "engine",
  pinned: false,
  mutualTopN: true,
  strength: "mutual",
  counterpartWithdrawn: false,
});

const model = buildModel({
  suppliers: [supplier("s1", "Zeta Hotel", 2, 2), supplier("s2", "Alpha Inn", 1, 1), supplier("s3", "No Desk", null, 0)],
  buyers: [buyer("b1", "Acme", "CEO", 2), buyer("b2", "Beta", "VP", 1), buyer("b3", "Gamma", "Lead", 0), buyer("b4", "Gone", "X", 0, true)],
  appointments: [appt("a1", 1, "b1", "s1"), appt("a2", 2, "b2", "s1"), appt("a3", 1, "b1", "s2")].map((a, i) =>
    i === 2 ? { ...a, slot: 2 } : a,
  ),
});

describe("parse helpers", () => {
  it("falls back to the supplier view and any slot", () => {
    expect(parseView("quality")).toBe("quality");
    expect(parseView("nope")).toBe("supplier");
    expect(parseView(null)).toBe("supplier");
    expect(parseFree("2", [{ slot: 1 }, { slot: 2 }])).toBe(2);
    expect(parseFree("9", [{ slot: 1 }])).toBe(0);
    expect(parseFree("x", [{ slot: 1 }])).toBe(0);
  });
});

describe("buildModel", () => {
  it("orders supplier lanes by desk with no desk last", () => {
    expect(model.suppliers.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);
  });

  it("indexes appointments by person and slot on both sides", () => {
    expect(model.bySlot.get("s1")?.get(1)?.buyerId).toBe("b1");
    expect(model.bySlot.get("b1")?.get(2)?.supplierId).toBe("s2");
  });
});

describe("health", () => {
  it("flags suppliers off target and buyers out of range", () => {
    expect(healthOf(model.personById.get("s1")!, TARGETS)).toBe("ok");
    expect(healthOf(model.personById.get("s2")!, TARGETS)).toBe("off");
    expect(healthOf(model.personById.get("b3")!, TARGETS)).toBe("under");
    expect(healthOf({ ...model.buyers[0], count: 3 }, TARGETS)).toBe("over");
  });

  it("never flags withdrawn people", () => {
    expect(healthOf(model.personById.get("b4")!, TARGETS)).toBe("ok");
  });

  it("explains the count", () => {
    expect(healthText(model.personById.get("b3")!, TARGETS)).toBe("0 meetings, 1 below the minimum of 1");
    expect(healthText(model.personById.get("s1")!, TARGETS)).toBe("2 of 2 meetings");
  });

  it("counts the people who need attention", () => {
    // s2 and s3 off target, b3 under.
    expect(attentionCount(model, TARGETS)).toBe(3);
  });
});

describe("lanesFor", () => {
  const none = { q: "", free: 0, flagged: false };

  it("hides withdrawn people with nothing booked", () => {
    expect(lanesFor(model, "buyer", none, TARGETS).map((p) => p.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("matches a lane by the person or anyone they meet", () => {
    expect(lanesFor(model, "supplier", { ...none, q: "acme" }, TARGETS).map((p) => p.id)).toEqual(["s2", "s1"]);
    expect(lanesFor(model, "buyer", { ...none, q: "zeta" }, TARGETS).map((p) => p.id)).toEqual(["b1", "b2"]);
  });

  it("keeps people free in a slot", () => {
    expect(lanesFor(model, "buyer", { ...none, free: 1 }, TARGETS).map((p) => p.id)).toEqual(["b2", "b3"]);
  });

  it("keeps count problems only", () => {
    expect(lanesFor(model, "supplier", { ...none, flagged: true }, TARGETS).map((p) => p.id)).toEqual(["s2", "s3"]);
  });
});

describe("freeIn and sheetRows", () => {
  it("lists active people free in a slot", () => {
    expect(freeIn(model, model.buyers, 2).map((b) => b.id)).toEqual(["b3"]);
  });

  it("builds one row per slot with the counterpart", () => {
    const slots = [1, 2, 3].map((n) => ({ slot: n, startMinutes: 0, endMinutes: 1, start: "", end: "" }));
    const rows = sheetRows(model, model.personById.get("b1")!, slots);
    expect(rows.map((r) => r.counterpart?.id ?? null)).toEqual(["s1", "s2", null]);
  });
});

describe("personLabel", () => {
  it("splits Organization - Title for buyers", () => {
    expect(personLabel(model.personById.get("b1")!)).toEqual({ primary: "Acme", secondary: "CEO" });
    expect(personLabel({ ...model.buyers[0], name: "Pat Lee" })).toEqual({ primary: "Pat Lee", secondary: "CEO" });
  });
});

describe("distribution", () => {
  it("pads to the target range and marks it", () => {
    expect(distribution({ 0: 1, 2: 3 }, TARGETS)).toEqual([
      { count: 0, buyers: 1, inRange: false },
      { count: 1, buyers: 0, inRange: true },
      { count: 2, buyers: 3, inRange: true },
    ]);
  });
});

describe("describeEdit", () => {
  const m = buildModel({
    suppliers: [supplier("s1", "Hyatt", 1, 2)],
    buyers: [buyer("b1", "Acme", "CEO", 2), buyer("b2", "Beta", "CFO", 0)],
    appointments: [appt("a1", 4, "b1", "s1")],
  });
  const add = { buyerId: "b2", name: "Beta", count: 0, countAfter: 1 };

  it("lists both sides of a replace and both buyers' counts; the supplier's count does not move", () => {
    expect(describeEdit(m, { supplierId: "s1", slot: 4, removeBuyerId: "b1", add })).toEqual({
      lines: ["Remove Acme from Hyatt, slot 4", "Add Beta to Hyatt, slot 4"],
      counts: [
        { personId: "b1", name: "Acme", before: 2, after: 1 },
        { personId: "b2", name: "Beta", before: 0, after: 1 },
      ],
    });
  });

  it("counts the supplier for an add or a remove", () => {
    expect(describeEdit(m, { supplierId: "s1", slot: 5, add }).counts.at(-1)).toEqual({ personId: "s1", name: "Hyatt", before: 2, after: 3 });
    const removal = describeEdit(m, { supplierId: "s1", slot: 4, removeBuyerId: "b1" });
    expect(removal.lines).toEqual(["Remove Acme from Hyatt, slot 4"]);
    expect(removal.counts.at(-1)).toEqual({ personId: "s1", name: "Hyatt", before: 2, after: 1 });
  });
});

