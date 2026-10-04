import type { QualityStats } from "@/engine";
import type {
  ScheduleAppointment,
  ScheduleBuyer,
  ScheduleSlot,
  ScheduleSupplier,
} from "@/server/schedule/queries";

/**
 * Pure derivations for the schedule workspace: indexes, count health, search,
 * and the lanes each view shows. No React, so it is unit tested.
 */

export const VIEWS = [
  { id: "supplier", label: "Supplier desks" },
  { id: "buyer", label: "Buyers" },
  { id: "slot", label: "By slot" },
  { id: "quality", label: "Quality" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

export function parseView(value: string | null): ViewId {
  return VIEWS.some((v) => v.id === value) ? (value as ViewId) : "supplier";
}

/** The `free` search param: a slot number that exists, else 0 for "any slot". */
export function parseFree(value: string | null, slots: readonly { slot: number }[]): number {
  const n = Number(value);
  return Number.isInteger(n) && slots.some((s) => s.slot === n) ? n : 0;
}

export type Targets = { supplierTarget: number; buyerMin: number; buyerMax: number };

export type SupplierPerson = ScheduleSupplier & { kind: "supplier" };
export type BuyerPerson = ScheduleBuyer & { kind: "buyer" };
export type Person = SupplierPerson | BuyerPerson;

export type ScheduleModel = {
  suppliers: SupplierPerson[];
  buyers: BuyerPerson[];
  personById: Map<string, Person>;
  /** Person id -> slot -> appointment, for both sides. */
  bySlot: Map<string, Map<number, ScheduleAppointment>>;
};

function compareDesk(a: SupplierPerson, b: SupplierPerson): number {
  if (a.desk === b.desk) return 0;
  if (a.desk === null) return 1;
  if (b.desk === null) return -1;
  return a.desk - b.desk;
}

export function buildModel(input: {
  suppliers: readonly ScheduleSupplier[];
  buyers: readonly ScheduleBuyer[];
  appointments: readonly ScheduleAppointment[];
}): ScheduleModel {
  // The server sends both lists sorted by name; desks go first for supplier lanes.
  const suppliers = input.suppliers
    .map((s) => ({ ...s, kind: "supplier" as const }))
    .sort((a, b) => compareDesk(a, b));
  const buyers = input.buyers.map((b) => ({ ...b, kind: "buyer" as const }));
  const personById = new Map<string, Person>();
  for (const p of [...suppliers, ...buyers]) personById.set(p.id, p);
  const bySlot = new Map<string, Map<number, ScheduleAppointment>>();
  const put = (id: string, a: ScheduleAppointment) => {
    let m = bySlot.get(id);
    if (!m) bySlot.set(id, (m = new Map()));
    m.set(a.slot, a);
  };
  for (const a of input.appointments) {
    put(a.supplierId, a);
    put(a.buyerId, a);
  }
  return { suppliers, buyers, personById, bySlot };
}

export function appointmentsOf(model: ScheduleModel, personId: string): Map<number, ScheduleAppointment> {
  return model.bySlot.get(personId) ?? new Map();
}

export type Health = "ok" | "under" | "over" | "off";

/** Suppliers should have exactly the target; buyers should be within min to max. Withdrawn people are never flagged. */
export function healthOf(person: Person, targets: Targets): Health {
  if (person.withdrawn) return "ok";
  const c = person.count;
  if (person.kind === "supplier") return c === targets.supplierTarget ? "ok" : "off";
  if (c < targets.buyerMin) return "under";
  if (c > targets.buyerMax) return "over";
  return "ok";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function healthText(person: Person, targets: Targets): string {
  const c = person.count;
  if (person.withdrawn) return `Withdrawn, ${plural(c, "meeting")} still booked`;
  const h = healthOf(person, targets);
  if (person.kind === "supplier") {
    return h === "ok" ? `${c} of ${targets.supplierTarget} meetings` : `${plural(c, "meeting")}, target is ${targets.supplierTarget}`;
  }
  if (h === "under") return `${plural(c, "meeting")}, ${targets.buyerMin - c} below the minimum of ${targets.buyerMin}`;
  if (h === "over") return `${plural(c, "meeting")}, ${c - targets.buyerMax} above the maximum of ${targets.buyerMax}`;
  return `${plural(c, "meeting")}, within ${targets.buyerMin} to ${targets.buyerMax}`;
}

/** People with a count problem, the number on the Quality tab. */
export function attentionCount(model: ScheduleModel, targets: Targets): number {
  let n = 0;
  for (const p of model.personById.values()) if (healthOf(p, targets) !== "ok") n++;
  return n;
}

/**
 * How a person reads in a lane: buyers stored as "Organization - Title"
 * (D34) show the organization with the title under it.
 */
export function personLabel(person: Person): { primary: string; secondary: string | null } {
  if (person.kind === "supplier") return { primary: person.name, secondary: null };
  const { organization, title, name } = person;
  if (organization && title && name === `${organization} - ${title}`) return { primary: organization, secondary: title };
  return { primary: name, secondary: title };
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export function personMatches(person: Person, q: string): boolean {
  if (!q) return true;
  const fields =
    person.kind === "supplier"
      ? [person.name, person.desk === null ? null : String(person.desk)]
      : [person.name, person.organization, person.title];
  return fields.some((f) => f !== null && f.toLowerCase().includes(q));
}

export type LaneFilters = { q: string; free: number; flagged: boolean };

/**
 * The lanes a timeline view shows. A lane matches the search when the person
 * matches or anyone they meet does. `free` keeps people with no meeting in
 * that slot; `flagged` keeps count problems only.
 */
export function lanesFor(
  model: ScheduleModel,
  mode: "supplier" | "buyer",
  filters: LaneFilters,
  targets: Targets,
): Person[] {
  const q = normalizeQuery(filters.q);
  const list: Person[] = mode === "supplier" ? model.suppliers : model.buyers;
  return list.filter((p) => {
    const mine = appointmentsOf(model, p.id);
    if (p.withdrawn && mine.size === 0) return false;
    if (filters.free && mine.has(filters.free)) return false;
    if (filters.flagged && healthOf(p, targets) === "ok") return false;
    if (!q || personMatches(p, q)) return true;
    for (const a of mine.values()) {
      const other = model.personById.get(mode === "supplier" ? a.buyerId : a.supplierId);
      if (other && personMatches(other, q)) return true;
    }
    return false;
  });
}

/** Active people with no meeting in `slot`. */
export function freeIn<T extends Person>(model: ScheduleModel, list: readonly T[], slot: number): T[] {
  return list.filter((p) => !p.withdrawn && !appointmentsOf(model, p.id).has(slot));
}

export function busyCount(model: ScheduleModel, list: readonly Person[], slot: number): number {
  return list.filter((p) => appointmentsOf(model, p.id).has(slot)).length;
}

/** Fewest meetings first, then name. Used for the free buyers lists. */
export function byFewest<T extends Person>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
}

export type SheetRow = {
  slot: ScheduleSlot;
  appointment: ScheduleAppointment | null;
  counterpart: Person | null;
};

/** One row per slot for the detail sheet, open slots included. */
export function sheetRows(model: ScheduleModel, person: Person, slots: readonly ScheduleSlot[]): SheetRow[] {
  const mine = appointmentsOf(model, person.id);
  return slots.map((slot) => {
    const appointment = mine.get(slot.slot) ?? null;
    const counterpartId = appointment ? (person.kind === "supplier" ? appointment.buyerId : appointment.supplierId) : null;
    return { slot, appointment, counterpart: counterpartId ? (model.personById.get(counterpartId) ?? null) : null };
  });
}

/** Buyer counts -> number of buyers with that count, padded to cover min..max. */
export function distribution(
  counts: Record<number, number> | undefined,
  targets: Targets,
): { count: number; buyers: number; inRange: boolean }[] {
  const entries = Object.entries(counts ?? {}).map(([k, v]) => [Number(k), v] as const);
  const keys = entries.map(([k]) => k);
  const lo = Math.min(targets.buyerMin, ...keys);
  const hi = Math.max(targets.buyerMax, ...keys);
  const map = new Map(entries);
  const rows: { count: number; buyers: number; inRange: boolean }[] = [];
  for (let c = Math.max(0, lo); c <= hi; c++) {
    rows.push({ count: c, buyers: map.get(c) ?? 0, inRange: c >= targets.buyerMin && c <= targets.buyerMax });
  }
  return rows;
}

/** What the server page hands the client workspace. Plain data only. */
export type WorkspaceData = {
  eventId: string;
  status: "draft" | "imported" | "matched" | "locked" | "sent" | "archived";
  eventDate: string;
  timezone: string;
  settings: Targets & { buyerIdeal: number; mutualTopN: number };
  run: { id: string; version: number; stats: QualityStats | null; warnings: string[] };
  slots: ScheduleSlot[];
  suppliers: ScheduleSupplier[];
  buyers: ScheduleBuyer[];
  appointments: ScheduleAppointment[];
};

const LOCKED_STATUSES: ReadonlySet<WorkspaceData["status"]> = new Set(["locked", "sent", "archived"]);

/** Locked, sent, and archived events refuse edits (AGENTS.md invariants). */
export function isLockedStatus(status: WorkspaceData["status"]): boolean {
  return LOCKED_STATUSES.has(status);
}
