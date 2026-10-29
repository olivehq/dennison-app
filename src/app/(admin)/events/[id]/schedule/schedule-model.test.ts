import { describe, expect, it } from "vitest";
import type { ScheduleAppointment, ScheduleBuyer, ScheduleSupplier } from "@/server/schedule/queries";
import {
  activeFilters,
  attentionCount,
  buildModel,
  candidateCountLine,
  affectedText,
  describeEdit,
  distribution,
  emptyFreeBuyersText,
  emptyLanesText,
  filtersFor,
  freeIn,
  healthOf,
  healthText,
  isBelowTarget,
  hasLane,
  isMostlyNeither,
  lanesFor,
  laneTotal,
  lockCountWarning,
  lockOutcomeText,
  matchesSearch,
  needAttentionText,
  openSlotsText,
  parseFree,
  parseView,
  personLabel,
  pickerFor,
  pickerRequestFor,
  PIN_DROP_NOTE,
  PIN_NOTE,
  plural,
  qualityVerdict,
  readUrlState,
  resultLine,
  sameUrlState,
  sheetRows,
  slotSearchFields,
  withdrawnNote,
  writeUrlState,
} from "./schedule-model";
import type { Person } from "./schedule-model";

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

describe("URL state", () => {
  const SLOTS = [1, 2, 3, 4].map((slot) => ({ slot }));
  const read = (search: string) => readUrlState(new URLSearchParams(search), SLOTS);

  it("reads every key, with defaults for missing or bad values", () => {
    expect(read("view=buyer&free=4&slot=2&q=acme&problems=1&withdrawn=1&neither=1&sel=b1")).toEqual({
      view: "buyer",
      free: 4,
      slot: 2,
      q: "acme",
      problems: true,
      withdrawn: true,
      neither: true,
      sel: "b1",
    });
    expect(read("view=nope&free=9&slot=7&problems=yes")).toEqual({
      view: "supplier",
      free: 0,
      slot: 0,
      q: "",
      problems: false,
      withdrawn: false,
      neither: false,
      sel: null,
    });
  });

  it("selecting a person keeps the view, the slot filter, the search, and the toggles", () => {
    // The client's case: Buyers view, free in slot 4, then "+ Open" on a lane.
    const search = "view=buyer&free=4&q=acme&neither=1";
    const next = writeUrlState(search, { sel: "b2" });
    expect(read(next)).toEqual({ ...read(search), sel: "b2" });
    // Closing the sheet again keeps them too.
    expect(read(writeUrlState(next, { sel: null }))).toEqual(read(search));
  });

  it("keeps keys it does not own and drops defaults", () => {
    expect(writeUrlState("utm=x&view=buyer&free=4&slot=2", { view: "supplier", free: 0, slot: 0 })).toBe("utm=x");
    expect(writeUrlState("", { problems: true, withdrawn: false, q: "" })).toBe("problems=1");
    expect(writeUrlState("problems=1&withdrawn=1&neither=1&q=a&free=2", { problems: false, withdrawn: false, neither: false, q: "", free: 0 })).toBe("");
  });

  it("round-trips a full state", () => {
    const state = { view: "slot" as const, free: 3, slot: 3, q: "hyatt", problems: true, withdrawn: false, neither: true, sel: "s1" };
    expect(read(writeUrlState("", state))).toEqual(state);
    expect(sameUrlState(read(writeUrlState("", state)), state)).toBe(true);
    expect(sameUrlState(state, { ...state, sel: null })).toBe(false);
    expect(sameUrlState(state, { ...state, slot: 4 })).toBe(false);
  });

  it("keeps the By slot pick, so a link or a refresh shows the same slot", () => {
    expect(writeUrlState("view=slot", { slot: 4 })).toBe("view=slot&slot=4");
    expect(read(writeUrlState("view=slot", { slot: 4 })).slot).toBe(4);
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

  it("counts lanes the way it shows them: a withdrawn person with no meetings is not a lane", () => {
    // b4 withdrew with nothing booked, so 3 of 4 buyers have a lane, and "All 3 buyers" is right.
    expect(laneTotal(model, "buyer")).toBe(3);
    expect(model.buyers.filter((b) => hasLane(model, b)).map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    // A withdrawn supplier keeps a lane while it still has meetings, and loses it when they are gone.
    const withMeetings = buildModel({
      suppliers: [supplier("s1", "Zeta Hotel", 1, 1), { ...supplier("s2", "Gone Inn", 2, 1), withdrawn: true }, { ...supplier("s3", "Empty Inn", null, 0), withdrawn: true }],
      buyers: [buyer("b1", "Acme", "CEO", 2)],
      appointments: [appt("a1", 1, "b1", "s1"), appt("a2", 2, "b1", "s2")],
    });
    expect(laneTotal(withMeetings, "supplier")).toBe(2);
    expect(lanesFor(withMeetings, "supplier", none, TARGETS)).toHaveLength(laneTotal(withMeetings, "supplier"));
  });

  it("matches a lane by the person or anyone they meet", () => {
    expect(lanesFor(model, "supplier", { ...none, q: "acme" }, TARGETS).map((p) => p.id)).toEqual(["s2", "s1"]);
    expect(lanesFor(model, "buyer", { ...none, q: "zeta" }, TARGETS).map((p) => p.id)).toEqual(["b1", "b2"]);
  });

  it("keeps people free in a slot", () => {
    expect(lanesFor(model, "buyer", { ...none, free: 1 }, TARGETS).map((p) => p.id)).toEqual(["b2", "b3"]);
  });

  it("shows the same free people in the timeline filter and the slot board", () => {
    for (const m of [model, withWithdrawn]) {
      for (const slot of [1, 2, 3]) {
        for (const mode of ["supplier", "buyer"] as const) {
          const list: Person[] = mode === "supplier" ? m.suppliers : m.buyers;
          const lanes = lanesFor(m, mode, { ...none, free: slot }, TARGETS).map((p) => p.id);
          expect(lanes).toEqual(freeIn(m, list, slot).map((p) => p.id));
        }
      }
    }
  });

  it("keeps count problems only", () => {
    expect(lanesFor(model, "supplier", { ...none, flagged: true }, TARGETS).map((p) => p.id)).toEqual(["s2", "s3"]);
  });

  // A buyer who withdrew after matching but still has meetings in slots 1 and 3.
  const withWithdrawn = buildModel({
    suppliers: [supplier("s1", "Zeta Hotel", 1, 2), supplier("s2", "Alpha Inn", 2, 1)],
    buyers: [buyer("b1", "Acme", "CEO", 1), buyer("w1", "Gone", "VP", 2, true)],
    appointments: [
      appt("a1", 2, "b1", "s1"),
      { ...appt("a2", 1, "w1", "s1"), counterpartWithdrawn: true },
      { ...appt("a3", 3, "w1", "s2"), counterpartWithdrawn: true },
    ],
  });

  it("never lists a withdrawn person as free in a slot, even with meetings in other slots", () => {
    expect(lanesFor(withWithdrawn, "buyer", { ...none, free: 2 }, TARGETS).map((p) => p.id)).toEqual([]);
    expect(lanesFor(withWithdrawn, "buyer", { ...none, free: 1 }, TARGETS).map((p) => p.id)).toEqual(["b1"]);
    expect(freeIn(withWithdrawn, withWithdrawn.buyers, 2)).toEqual([]);
    // Without the slot filter the lane still shows, so its meetings can be fixed.
    expect(lanesFor(withWithdrawn, "buyer", none, TARGETS).map((p) => p.id)).toEqual(["b1", "w1"]);
  });

  it("keeps lanes with a withdrawn meeting only", () => {
    expect(lanesFor(withWithdrawn, "supplier", { ...none, withdrawnOnly: true }, TARGETS).map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(lanesFor(withWithdrawn, "buyer", { ...none, withdrawnOnly: true }, TARGETS).map((p) => p.id)).toEqual(["w1"]);
  });

  it("keeps mostly-neither lanes only", () => {
    const m = buildModel({
      suppliers: [supplier("s1", "Zeta Hotel", 1, 2), supplier("s2", "Alpha Inn", 2, 2)],
      buyers: [buyer("b1", "Acme", "CEO", 2), buyer("b2", "Beta", "VP", 2)],
      appointments: [
        { ...appt("a1", 1, "b1", "s1"), strength: "neither" },
        appt("a2", 2, "b1", "s2"),
        appt("a3", 1, "b2", "s2"),
        { ...appt("a4", 2, "b2", "s1"), strength: "blank" },
      ],
    });
    expect(lanesFor(m, "buyer", { ...none, mostlyNeither: true }, TARGETS).map((p) => p.id)).toEqual(["b1"]);
    expect(lanesFor(m, "supplier", { ...none, mostlyNeither: true }, TARGETS).map((p) => p.id)).toEqual(["s1"]);
  });
});

describe("isMostlyNeither", () => {
  const lane = (neither: number, other: number) => [
    ...Array.from({ length: neither }, () => ({ strength: "neither" as const })),
    ...Array.from({ length: other }, () => ({ strength: "mutual" as const })),
  ];

  it("rounds half down: 9 meetings qualify at 4, not 5", () => {
    expect(isMostlyNeither(lane(4, 5))).toBe(true);
    expect(isMostlyNeither(lane(3, 6))).toBe(false);
  });

  it("needs half of an even count", () => {
    expect(isMostlyNeither(lane(4, 4))).toBe(true);
    expect(isMostlyNeither(lane(3, 5))).toBe(false);
  });

  it("needs at least one Neither and at least one meeting", () => {
    expect(isMostlyNeither(lane(1, 0))).toBe(true);
    expect(isMostlyNeither(lane(0, 1))).toBe(false);
    expect(isMostlyNeither([])).toBe(false);
  });

  it("counts only Neither, not a blank rank", () => {
    expect(isMostlyNeither([{ strength: "blank" }, { strength: "blank" }])).toBe(false);
  });
});

describe("isBelowTarget and withdrawnNote", () => {
  it("marks suppliers under target and buyers under the minimum, never withdrawn people", () => {
    expect(isBelowTarget(model.personById.get("s2")!, TARGETS)).toBe(true);
    expect(isBelowTarget(model.personById.get("s1")!, TARGETS)).toBe(false);
    expect(isBelowTarget(model.personById.get("b3")!, TARGETS)).toBe(true);
    expect(isBelowTarget(model.personById.get("b2")!, TARGETS)).toBe(false);
    expect(isBelowTarget(model.personById.get("b4")!, TARGETS)).toBe(false);
  });

  it("names who withdrew", () => {
    expect(withdrawnNote(model, { buyerId: "b4", supplierId: "s1" })).toBe(
      "Gone withdrew. Replace or remove this meeting before locking.",
    );
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

  it("counts open slots for active people only", () => {
    const slots = [1, 2, 3].map((n) => ({ slot: n, startMinutes: 0, endMinutes: 1, start: "", end: "" }));
    const b1 = model.personById.get("b1")!;
    expect(openSlotsText(b1, sheetRows(model, b1, slots))).toBe("1 open slot");
    const b3 = model.personById.get("b3")!;
    expect(openSlotsText(b3, sheetRows(model, b3, slots))).toBe("3 open slots");
    expect(openSlotsText(b1, sheetRows(model, b1, slots.slice(0, 2)))).toBe("No open slots");
    // A withdrawn buyer gets no new meetings, so an empty slot is not "open".
    const gone = model.personById.get("b4")!;
    expect(openSlotsText(gone, sheetRows(model, gone, slots))).toBeNull();
  });
});

describe("pickerRequestFor and pickerFor", () => {
  const slots = [1, 2, 3].map((n) => ({ slot: n, startMinutes: 0, endMinutes: 1, start: `${n}:00`, end: `${n}:10` }));
  const rowsOf = (id: string) => sheetRows(model, model.personById.get(id)!, slots);

  it("Replace on a buyer's sheet replaces that buyer at the supplier, and the picker stays open for that sheet", () => {
    const b1 = model.personById.get("b1")!;
    const request = pickerRequestFor(model, b1, rowsOf("b1")[0], true);
    expect(request).toEqual({
      pick: "buyer",
      ownerId: "b1",
      supplierId: "s1",
      supplierName: "Zeta Hotel",
      slot: 1,
      slotLabel: "1:00 to 1:10",
      removeBuyerId: "b1",
      removeBuyerName: "Acme",
    });
    // The regression: the picker was matched against its supplier, so a buyer's sheet never showed it.
    expect(pickerFor(request, "b1")).toBe(request);
    expect(pickerFor(request, "s1")).toBeNull();
  });

  it("Replace and Add on a supplier's sheet, and an open slot on a buyer's sheet, belong to that sheet", () => {
    const s1 = model.personById.get("s1")!;
    const replace = pickerRequestFor(model, s1, rowsOf("s1")[1], true);
    expect(replace).toMatchObject({ pick: "buyer", ownerId: "s1", supplierId: "s1", removeBuyerId: "b2", removeBuyerName: "Beta" });
    const add = pickerRequestFor(model, s1, rowsOf("s1")[2], false);
    expect(add).toMatchObject({ pick: "buyer", ownerId: "s1", supplierId: "s1", slot: 3 });
    expect(add).toMatchObject({ removeBuyerId: undefined });
    const open = pickerRequestFor(model, model.personById.get("b1")!, rowsOf("b1")[2], false);
    expect(open).toMatchObject({ pick: "supplier", ownerId: "b1", buyerId: "b1", buyerName: "Acme", slot: 3 });
    expect(pickerFor(open, "b1")).toBe(open);
    // Back to another person: a picker opened elsewhere is ignored.
    expect(pickerFor(open, "b2")).toBeNull();
    expect(pickerFor(null, "b1")).toBeNull();
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
      dropsPin: false,
    });
  });

  it("warns only when a replace removes a pinned meeting (D116)", () => {
    const pinned = buildModel({
      suppliers: [supplier("s1", "Hyatt", 1, 2)],
      buyers: [buyer("b1", "Acme", "CEO", 2), buyer("b2", "Beta", "CFO", 0)],
      appointments: [{ ...appt("a1", 4, "b1", "s1"), pinned: true }],
    });
    expect(describeEdit(pinned, { supplierId: "s1", slot: 4, removeBuyerId: "b1", add }).dropsPin).toBe(true);
    // A plain removal has its own confirm, and an add has no pin to drop.
    expect(describeEdit(pinned, { supplierId: "s1", slot: 4, removeBuyerId: "b1" }).dropsPin).toBe(false);
    expect(describeEdit(pinned, { supplierId: "s1", slot: 5, add }).dropsPin).toBe(false);
    expect(describeEdit(m, { supplierId: "s1", slot: 4, removeBuyerId: "b1", add }).dropsPin).toBe(false);
    expect(PIN_DROP_NOTE).toBe("This meeting is pinned. Replacing it removes the pin.");
  });

  it("counts the supplier for an add or a remove", () => {
    expect(describeEdit(m, { supplierId: "s1", slot: 5, add }).counts.at(-1)).toEqual({ personId: "s1", name: "Hyatt", before: 2, after: 3 });
    const removal = describeEdit(m, { supplierId: "s1", slot: 4, removeBuyerId: "b1" });
    expect(removal.lines).toEqual(["Remove Acme from Hyatt, slot 4"]);
    expect(removal.counts.at(-1)).toEqual({ personId: "s1", name: "Hyatt", before: 2, after: 1 });
  });
});


describe("matchesSearch", () => {
  const people = [
    ["McDonald Hospitality"],
    ["Medtronic", "Medtronic - Travel Manager"],
    ["Shaw Yoder", "Shaw Yoder - Director"],
    ["Wyndham Resorts", null, "Events"],
  ];
  const find = (q: string) => people.filter((fields) => matchesSearch(q, fields)).map((f) => f[0]);

  it("finds the organization typed and nothing else", () => {
    expect(find("medtronic")).toEqual(["Medtronic"]);
    expect(find("MEDTRONIC")).toEqual(["Medtronic"]);
    expect(find("wyndham")).toEqual(["Wyndham Resorts"]);
  });

  it("matches the start of words, in any field, for every word typed", () => {
    expect(find("med")).toEqual(["Medtronic"]);
    expect(find("travel man")).toEqual(["Medtronic"]);
    expect(find("tronic")).toEqual([]);
    expect(find("shaw director")).toEqual(["Shaw Yoder"]);
    expect(find("shaw events")).toEqual([]);
  });

  it("returns nothing for text no one has", () => {
    expect(find("zzzz")).toEqual([]);
  });

  it("ignores accents and punctuation, and an empty query matches everything", () => {
    expect(matchesSearch("hotel", ["Hôtel Le-Grand"])).toBe(true);
    expect(matchesSearch("le grand", ["Hôtel Le-Grand"])).toBe(true);
    expect(find("  ")).toHaveLength(people.length);
  });

  it("finds slot 3 and not slot 13, and a desk by number", () => {
    const slots = [3, 13, 30].map((n) => [`Slot ${n}`]);
    expect(slots.filter((f) => matchesSearch("slot 3", f)).map((f) => f[0])).toEqual(["Slot 3", "Slot 30"]);
    expect(matchesSearch("slot 3", ["Slot 13"])).toBe(false);
    expect(matchesSearch("desk 12", ["Hyatt", "desk 12"])).toBe(true);
  });

  it("finds a slot by its start time, and a number alone never matches a time", () => {
    const slots = [
      { slot: 3, start: "10:30 AM" },
      { slot: 13, start: "3:21 PM" },
      { slot: 30, start: "3:51 PM" },
    ];
    const find = (q: string) => slots.filter((s) => matchesSearch(q, slotSearchFields(s))).map((s) => s.slot);
    expect(find("10:30")).toEqual([3]);
    expect(find("3:21")).toEqual([13]);
    expect(find("3:21 pm")).toEqual([13]);
    expect(find("3:")).toEqual([13, 30]);
    expect(find("slot 3")).toEqual([3, 30]);
    expect(find("slot 13")).toEqual([13]);
    expect(find("10")).toEqual([]);
    expect(find("pm")).toEqual([13, 30]);
  });
});

describe("lockCountWarning", () => {
  const base = { buyerMin: 3, supplierTarget: 9 };

  it("warns about buyers below the minimum and suppliers below target", () => {
    expect(lockCountWarning({ ...base, buyersBelowMin: 2, suppliersBelowTarget: 0 })).toBe("2 buyers are still below 3 meetings.");
    expect(lockCountWarning({ ...base, buyersBelowMin: 0, suppliersBelowTarget: 2 })).toBe(
      "2 suppliers have fewer than 9 meetings, so those desks have open slots.",
    );
    expect(lockCountWarning({ ...base, buyersBelowMin: 1, suppliersBelowTarget: 1 })).toBe(
      "1 buyer is still below 3 meetings. 1 supplier has fewer than 9 meetings, so that desk has open slots.",
    );
  });

  it("says when everyone is within target", () => {
    expect(lockCountWarning({ ...base, buyersBelowMin: 0, suppliersBelowTarget: 0 })).toBe("Every buyer and supplier is within target.");
  });
});

describe("candidateCountLine", () => {
  it("counts the slot's candidates, and how many match while searching", () => {
    expect(candidateCountLine("buyer", 12, 12, false)).toBe("12 buyers can take this slot");
    expect(candidateCountLine("supplier", 1, 1, false)).toBe("1 supplier can take this slot");
    expect(candidateCountLine("buyer", 1, 12, true)).toBe("1 of 12 match");
    expect(candidateCountLine("buyer", 0, 12, true)).toBe("0 of 12 match");
  });
});

describe("toolbar filters", () => {
  const off = { free: 0, problems: false, withdrawn: false, neither: false };
  const allOn = { free: 4, problems: true, withdrawn: true, neither: true };

  it("shows each view only the filters that apply to it", () => {
    expect(filtersFor("supplier")).toEqual(["free", "problems", "withdrawn", "neither"]);
    expect(filtersFor("buyer")).toEqual(["free", "problems", "withdrawn", "neither"]);
    expect(filtersFor("slot")).toEqual(["free", "problems"]);
    expect(filtersFor("quality")).toEqual([]);
  });

  it("lists the filters that are on, in menu order, with chip labels", () => {
    expect(activeFilters({ view: "buyer", ...off })).toEqual([]);
    expect(activeFilters({ view: "buyer", ...allOn })).toEqual([
      { key: "free", label: "Free in slot 4" },
      { key: "problems", label: "Count problems" },
      { key: "withdrawn", label: "Withdrawn only" },
      { key: "neither", label: "Mostly neither" },
    ]);
  });

  it("does not count a filter the view does not show, so its count and chips match the menu", () => {
    expect(activeFilters({ view: "slot", ...allOn }).map((f) => f.key)).toEqual(["free", "problems"]);
    expect(activeFilters({ view: "quality", ...allOn })).toEqual([]);
  });
});

describe("resultLine", () => {
  const base = { lanes: { shown: 70, total: 70 }, boardSlot: 3, q: "", active: [], free: 0 } as const;

  it("names the lanes shown out of the total, then each filter", () => {
    expect(resultLine({ ...base, view: "buyer" })).toBe("All 70 buyers");
    expect(
      resultLine({ ...base, view: "buyer", lanes: { shown: 7, total: 70 }, active: ["free", "problems"], free: 4 }),
    ).toBe("7 of 70 buyers, free in slot 4, with count problems");
    expect(
      resultLine({ ...base, view: "supplier", lanes: { shown: 2, total: 77 }, active: ["withdrawn", "neither"], q: " hil " }),
    ).toBe("2 of 77 supplier desks, with withdrawn meetings, mostly neither, matching “hil”");
  });

  it("names the board slot on By slot and the whole schedule on Quality", () => {
    expect(resultLine({ ...base, view: "slot", active: ["free", "problems"], free: 3 })).toBe("Slot 3");
    expect(resultLine({ ...base, view: "quality", q: "ace" })).toBe("Whole schedule, matching “ace”");
  });
});

describe("emptyLanesText", () => {
  const off = { free: 0, q: "", flagged: false, withdrawnOnly: false, mostlyNeither: false };

  it("says the slot is full only when Free in is the only reason for the empty list", () => {
    expect(emptyLanesText({ ...off, mode: "buyer", free: 3 })).toEqual({
      title: "No one free in slot 3",
      description: "Every buyer is in a meeting in slot 3.",
    });
    expect(emptyLanesText({ ...off, mode: "supplier", free: 3 }).description).toBe(
      "Every supplier desk is booked in slot 3. Open slots live with buyers below target.",
    );
  });

  it("names the active filters when Free in is combined with another", () => {
    expect(emptyLanesText({ ...off, mode: "buyer", free: 3, flagged: true })).toEqual({
      title: "No matches",
      description: "No buyer free in slot 3 has a count problem.",
    });
    expect(emptyLanesText({ ...off, mode: "supplier", free: 3, flagged: true, mostlyNeither: true }).description).toBe(
      "No supplier desk free in slot 3 has a count problem and mostly Neither meetings.",
    );
    expect(emptyLanesText({ ...off, mode: "buyer", free: 3, q: " acme " }).description).toBe(
      "No buyer free in slot 3 matching “acme”.",
    );
    expect(emptyLanesText({ ...off, mode: "buyer", free: 3, q: "acme", flagged: true }).description).toBe(
      "No buyer free in slot 3 matching “acme” has a count problem.",
    );
  });

  it("describes filters without Free in, and a search alone", () => {
    expect(emptyLanesText({ ...off, mode: "buyer", withdrawnOnly: true }).description).toBe(
      "No buyer has a meeting with someone who withdrew.",
    );
    expect(emptyLanesText({ ...off, mode: "buyer", q: "zzz" }).description).toBe(
      "Nothing matches “zzz”. Search covers supplier names, buyer organizations and titles.",
    );
    expect(emptyLanesText({ ...off, mode: "buyer" }).description).toBe("Nobody in this view matches.");
  });
});

describe("emptyFreeBuyersText", () => {
  it("only claims a full slot when nobody is free", () => {
    expect(emptyFreeBuyersText({ anyFree: false, q: "", flagged: true })).toBe("Every buyer has a meeting in this slot.");
    expect(emptyFreeBuyersText({ anyFree: true, q: "", flagged: true })).toBe("No free buyer has a count problem.");
    expect(emptyFreeBuyersText({ anyFree: true, q: "acme", flagged: true })).toBe(
      "No free buyer matching your search has a count problem.",
    );
    expect(emptyFreeBuyersText({ anyFree: true, q: "acme", flagged: false })).toBe("No free buyer matches your search.");
  });
});

describe("count headlines", () => {
  it("needAttentionText agrees with the count", () => {
    expect(needAttentionText(1)).toBe("1 needs attention");
    expect(needAttentionText(0)).toBe("0 need attention");
    expect(needAttentionText(3)).toBe("3 need attention");
  });

  it("plural keeps the noun in step", () => {
    expect(plural(1, "slot")).toBe("1 slot");
    expect(plural(2, "slot")).toBe("2 slots");
  });

  const verdict = {
    appointments: 504,
    slots: 9,
    suppliersAtTarget: 56,
    totalSuppliers: 56,
    supplierTarget: 9,
    buyersInRange: 64,
    totalBuyers: 65,
    buyerMin: 7,
    buyerMax: 9,
    outOfRange: 1,
  };

  it("qualityVerdict says needs for one and need for more", () => {
    expect(qualityVerdict(verdict)).toBe(
      "504 appointments over 9 slots. Every supplier has 9. 64 of 65 buyers are within 7 to 9; 1 needs attention.",
    );
    expect(qualityVerdict({ ...verdict, buyersInRange: 62, outOfRange: 3, suppliersAtTarget: 55 })).toBe(
      "504 appointments over 9 slots. 55 of 56 suppliers have 9. 62 of 65 buyers are within 7 to 9; 3 need attention.",
    );
    expect(qualityVerdict({ ...verdict, buyersInRange: 65, outOfRange: 0 }).endsWith("65 of 65 buyers are within 7 to 9.")).toBe(true);
  });

  it("qualityVerdict handles a single appointment, slot, and buyer", () => {
    expect(
      qualityVerdict({ ...verdict, appointments: 1, slots: 1, totalBuyers: 1, buyersInRange: 0, outOfRange: 1, suppliersAtTarget: 1, totalSuppliers: 1 }),
    ).toBe("1 appointment over 1 slot. Every supplier has 9. 0 of 1 buyer is within 7 to 9; 1 needs attention.");
  });
});

describe("lockOutcomeText", () => {
  it("never says everyone has a link when someone's link was revoked", () => {
    expect(lockOutcomeText({ desks: 56, issued: 0, kept: 176, revoked: 1 })).toBe(
      "56 desks assigned. 176 links kept. 1 person has a revoked link and got no new one. Use Regenerate on the roster.",
    );
    expect(lockOutcomeText({ desks: 56, issued: 2, kept: 174, revoked: 3 })).toBe(
      "56 desks assigned. 2 participant links issued, 174 kept. 3 people have a revoked link and got no new one. Use Regenerate on the roster.",
    );
  });

  it("reports issued links on a first lock", () => {
    expect(lockOutcomeText({ desks: 56, issued: 177, kept: 0 })).toBe("56 desks assigned and 177 participant links issued.");
    expect(lockOutcomeText({ desks: 1, issued: 1, kept: 0 })).toBe("1 desk assigned and 1 participant link issued.");
  });

  it("does not say zero links on a second lock, when the first lock's links are kept", () => {
    expect(lockOutcomeText({ desks: 56, issued: 0, kept: 177 })).toBe("56 desks assigned. Everyone already has a link (177 links).");
    expect(lockOutcomeText({ desks: 56, issued: 3, kept: 174 })).toBe("56 desks assigned. 3 participant links issued, 174 kept.");
    expect(lockOutcomeText({ desks: 56, issued: 0, kept: 0 })).toBe("56 desks assigned.");
  });
});

describe("toast copy", () => {
  it("affectedText drops counts that did not move", () => {
    expect(
      affectedText([
        { name: "Art of Mentoring", before: 9, after: 9 },
        { name: "Medtronic", before: 9, after: 8 },
      ]),
    ).toBe("Medtronic: 9 → 8.");
    expect(affectedText([{ name: "Art of Mentoring", before: 9, after: 9 }])).toBe("");
  });

  it("the pin note says what runs do with a pin", () => {
    expect(PIN_NOTE).toBe("Marked as reviewed. Re-run and keep existing keeps this meeting; Run matching clears pins.");
  });
});
