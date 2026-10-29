import type { QualityStats } from "@/engine";
import { eventAllows } from "@/lib/event-gates";
import { compareNames } from "@/lib/names";
import type {
  ScheduleAppointment,
  ScheduleBuyer,
  ScheduleSlot,
  ScheduleSupplier,
  WithdrawnEntry,
} from "@/server/schedule/queries";
import type { SwapCandidate } from "@/server/schedule/edits";
import type { PickerRequest } from "./swap-picker";

/**
 * Pure derivations for the schedule workspace: indexes, count health, search,
 * and the lanes each view shows. No React, so it is unit tested.
 */

export const VIEWS = [
  // `short` is the toolbar label; the full label stays the accessible name and the command menu's word.
  { id: "supplier", label: "Supplier desks", short: "Desks" },
  { id: "buyer", label: "Buyers" },
  { id: "slot", label: "By slot" },
  { id: "quality", label: "Quality" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

export function parseView(value: string | null): ViewId {
  return VIEWS.some((v) => v.id === value) ? (value as ViewId) : "supplier";
}

/** The `free` and `slot` search params: a slot number that exists, else 0 (any slot, or no pick). */
export function parseFree(value: string | null, slots: readonly { slot: number }[]): number {
  const n = Number(value);
  return Number.isInteger(n) && slots.some((s) => s.slot === n) ? n : 0;
}

/**
 * Everything the workspace keeps in the URL so a link, a refresh, or Back
 * reproduces the screen. The workspace holds this in React state and mirrors
 * it to the URL; it reads the URL on load and on Back and Forward only.
 */
export type WorkspaceUrlState = {
  view: ViewId;
  q: string;
  /** Slot number for "Free in", 0 for any slot. */
  free: number;
  /** The slot picked on the By slot tab, 0 for none (the board follows the clock). */
  slot: number;
  /** "Count problems only". */
  problems: boolean;
  /** "Withdrawn only". */
  withdrawn: boolean;
  /** "Mostly neither". */
  neither: boolean;
  /** The person whose sheet is open. */
  sel: string | null;
};

const TOGGLE_PARAMS = ["problems", "withdrawn", "neither"] as const;

export function readUrlState(
  params: { get(name: string): string | null },
  slots: readonly { slot: number }[],
): WorkspaceUrlState {
  return {
    view: parseView(params.get("view")),
    q: params.get("q") ?? "",
    free: parseFree(params.get("free"), slots),
    slot: parseFree(params.get("slot"), slots),
    problems: params.get("problems") === "1",
    withdrawn: params.get("withdrawn") === "1",
    neither: params.get("neither") === "1",
    sel: params.get("sel") || null,
  };
}

/**
 * The query string (no leading "?") for `search` with `patch` applied. Keys
 * the patch does not name, ours or anyone else's, stay as they are, so
 * selecting a person can never drop the view or a filter. Defaults are left
 * out: the supplier view, any slot, no slot pick, an empty search, toggles off.
 */
export function writeUrlState(search: string, patch: Partial<WorkspaceUrlState>): string {
  const params = new URLSearchParams(search);
  const put = (key: string, value: string | null) => {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  };
  if (patch.view !== undefined) put("view", patch.view === "supplier" ? null : patch.view);
  if (patch.q !== undefined) put("q", patch.q);
  if (patch.free !== undefined) put("free", patch.free ? String(patch.free) : null);
  if (patch.slot !== undefined) put("slot", patch.slot ? String(patch.slot) : null);
  if (patch.sel !== undefined) put("sel", patch.sel);
  for (const key of TOGGLE_PARAMS) {
    const value = patch[key];
    if (value !== undefined) put(key, value ? "1" : null);
  }
  return params.toString();
}

export function sameUrlState(a: WorkspaceUrlState, b: WorkspaceUrlState): boolean {
  return (
    a.view === b.view &&
    a.q === b.q &&
    a.free === b.free &&
    a.slot === b.slot &&
    a.problems === b.problems &&
    a.withdrawn === b.withdrawn &&
    a.neither === b.neither &&
    a.sel === b.sel
  );
}

/** The items in the toolbar's Filters menu, in menu order. */
export type FilterKey = "free" | "problems" | "withdrawn" | "neither";

/**
 * The Filters items a view shows. Quality has none, By slot has Free in and
 * Count problems, the two timelines have all four. A filter that is on in the
 * URL but not shown here does nothing in this view (the URL keeps it so
 * switching back restores it).
 */
export function filtersFor(view: ViewId): FilterKey[] {
  if (view === "quality") return [];
  if (view === "slot") return ["free", "problems"];
  return ["free", "problems", "withdrawn", "neither"];
}

/** The filters that are on and count in this view, with the label of their chip. */
export function activeFilters(
  state: Pick<WorkspaceUrlState, "view" | "free" | "problems" | "withdrawn" | "neither">,
): { key: FilterKey; label: string }[] {
  const labels: Record<FilterKey, string | null> = {
    free: state.free ? `Free in slot ${state.free}` : null,
    problems: state.problems ? "Count problems" : null,
    withdrawn: state.withdrawn ? "Withdrawn only" : null,
    neither: state.neither ? "Mostly neither" : null,
  };
  return filtersFor(state.view).flatMap((key) => {
    const label = labels[key];
    return label ? [{ key, label }] : [];
  });
}

/**
 * The line beside the filter chips: "7 of 70 buyers, free in slot 4, with
 * count problems". `lanes` is the shown and total lane count in a timeline
 * view; `boardSlot` is the slot the By slot board shows.
 */
export function resultLine(input: {
  view: ViewId;
  lanes: { shown: number; total: number };
  boardSlot: number;
  q: string;
  active: readonly FilterKey[];
  free: number;
}): string {
  const { view, lanes, boardSlot, q, active, free } = input;
  const parts: string[] = [];
  if (view === "supplier" || view === "buyer") {
    const noun = view === "supplier" ? "supplier desk" : "buyer";
    parts.push(lanes.shown === lanes.total ? `All ${lanes.total} ${noun}s` : `${lanes.shown} of ${lanes.total} ${noun}s`);
    if (active.includes("free")) parts.push(`free in slot ${free}`);
    if (active.includes("problems")) parts.push("with count problems");
    if (active.includes("withdrawn")) parts.push("with withdrawn meetings");
    if (active.includes("neither")) parts.push("mostly neither");
  } else if (view === "slot") {
    // The board already is the Free in slot, and the chips say which filters are on.
    parts.push(`Slot ${boardSlot}`);
  } else {
    parts.push("Whole schedule");
  }
  if (q.trim()) parts.push(`matching “${q.trim()}”`);
  return parts.join(", ");
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

/**
 * Fewer meetings than the person should have: a supplier under the target, a
 * buyer under the minimum. Their open slots are drawn as "Needs filling".
 */
export function isBelowTarget(person: Person, targets: Targets): boolean {
  if (person.withdrawn) return false;
  return person.kind === "supplier" ? person.count < targets.supplierTarget : person.count < targets.buyerMin;
}

/**
 * "Mostly neither": at least half of the lane's meetings, rounded down, are
 * in the Neither category (neither side ranked the other in the top N).
 * 9 meetings qualify at 4, 8 at 4, 1 at 1. A lane with no meetings does not.
 */
export function isMostlyNeither(appointments: Iterable<Pick<ScheduleAppointment, "strength">>): boolean {
  let total = 0;
  let neither = 0;
  for (const a of appointments) {
    total++;
    if (a.strength === "neither") neither++;
  }
  return total > 0 && neither >= Math.max(1, Math.floor(total / 2));
}

/** The note on a meeting with someone who withdrew. One wording for the block's title, hover card, and label. */
export function withdrawnNote(model: ScheduleModel, a: Pick<ScheduleAppointment, "buyerId" | "supplierId">): string {
  const names = [a.supplierId, a.buyerId]
    .map((id) => model.personById.get(id))
    .filter((p): p is Person => p !== undefined && p.withdrawn)
    .map((p) => personLabel(p).primary);
  return `${names.length ? names.join(" and ") : "Someone in this meeting"} withdrew. Replace or remove this meeting before locking.`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the lock dialog says it produced. A second lock keeps the links the first
 * one issued. A contact whose link was revoked gets none, so the text never
 * claims everyone has a link while someone doesn't.
 */
export function lockOutcomeText(input: {
  desks: number;
  issued: number;
  kept: number;
  revoked?: number;
  /** Who the revoked contacts are. Up to three are named, then "and N more". Without names the note counts them. */
  revokedNames?: readonly string[];
}): string {
  const { issued, kept, revoked = 0, revokedNames = [] } = input;
  const desks = `${plural(input.desks, "desk")} assigned`;
  let links: string;
  if (issued === 0 && kept > 0) {
    links = revoked > 0 ? `. ${plural(kept, "link")} kept.` : `. Everyone already has a link (${plural(kept, "link")}).`;
  } else if (issued > 0 && kept > 0) {
    links = `. ${plural(issued, "participant link")} issued, ${kept} kept.`;
  } else if (issued > 0) {
    links = ` and ${plural(issued, "participant link")} issued.`;
  } else {
    links = ".";
  }
  let note = "";
  if (revoked > 0) {
    const shown = revokedNames.slice(0, 3);
    const items = shown.length === 0 ? [plural(revoked, "person", "people")] : [...shown, ...(revoked > shown.length ? [`${revoked - shown.length} more`] : [])];
    const who = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
    note = ` ${who} ${revoked === 1 ? "has" : "have"} a revoked link and got no new one. Use Regenerate on the roster.`;
  }
  return `${desks}${links}${note}`;
}

/** "1 needs attention", "3 need attention": the count headline on the Quality tab and view. */
export function needAttentionText(n: number): string {
  return `${n} ${n === 1 ? "needs" : "need"} attention`;
}

/** The Quality view headline, with every count agreeing with its noun. */
export function qualityVerdict(input: {
  appointments: number;
  slots: number;
  suppliersAtTarget: number;
  totalSuppliers: number;
  supplierTarget: number;
  buyersInRange: number;
  totalBuyers: number;
  buyerMin: number;
  buyerMax: number;
  outOfRange: number;
}): string {
  const i = input;
  const suppliers =
    i.suppliersAtTarget === i.totalSuppliers
      ? `Every supplier has ${i.supplierTarget}. `
      : `${i.suppliersAtTarget} of ${plural(i.totalSuppliers, "supplier")} ${i.totalSuppliers === 1 ? "has" : "have"} ${i.supplierTarget}. `;
  return (
    `${plural(i.appointments, "appointment")} over ${plural(i.slots, "slot")}. ` +
    suppliers +
    `${i.buyersInRange} of ${plural(i.totalBuyers, "buyer")} ${i.totalBuyers === 1 ? "is" : "are"} within ${i.buyerMin} to ${i.buyerMax}` +
    (i.outOfRange ? `; ${needAttentionText(i.outOfRange)}.` : ".")
  );
}

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

/**
 * Lowercase words with accents removed: "Hôtel Le-Grand 12" is ["hotel", "le",
 * "grand", "12"]. A clock time stays one word: "3:21 PM" is ["3:21", "pm"].
 */
export function searchWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/\d{1,2}:\d*|[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Quick find in the Add and Replace pickers and Cmd-K: every word typed must
 * start a word in one of the fields, ignoring case and accents. "medtronic"
 * finds Medtronic and nothing else, "slot 3" finds slot 3 but not slot 13.
 * A clock time ("3:21") is matched only by a typed word that has a colon, so
 * "slot 3" doesn't find the slot that starts at 3:21. An empty query matches
 * everything.
 */
export function matchesSearch(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const wanted = searchWords(query);
  if (wanted.length === 0) return true;
  const words = fields.flatMap((f) => (f ? searchWords(f) : []));
  return wanted.every((w) => words.some((word) => word.startsWith(w) && (w.includes(":") || !word.includes(":"))));
}

/** What Cmd-K searches for a slot: its number and its start time as shown ("Slot 3", "3:21 PM"). */
export function slotSearchFields(slot: Pick<ScheduleSlot, "slot" | "start">): string[] {
  return [`Slot ${slot.slot}`, slot.start];
}

/** The words the picker search looks at: the name, organization and title for a buyer, the name and desk for a supplier. */
export function candidateFields(c: SwapCandidate): (string | null)[] {
  return c.kind === "buyer" ? [c.name, c.organization, c.title] : [c.name, c.desk === null ? null : `desk ${c.desk}`];
}

/** "12 buyers can take this slot", or "3 of 12 match" while searching. */
export function candidateCountLine(noun: "buyer" | "supplier", shown: number, total: number, searching: boolean): string {
  if (searching) return `${shown} of ${total} match`;
  return `${total} ${total === 1 ? noun : `${noun}s`} can take this slot`;
}

export function personMatches(person: Person, q: string): boolean {
  if (!q) return true;
  const fields =
    person.kind === "supplier"
      ? [person.name, person.desk === null ? null : String(person.desk)]
      : [person.name, person.organization, person.title];
  return fields.some((f) => f !== null && f.toLowerCase().includes(q));
}

/**
 * Whether the timeline draws a lane for this person: everyone active, plus
 * withdrawn people who still have meetings to replace or remove. A withdrawn
 * person with no meetings is gone from the schedule, lane counts included.
 */
export function hasLane(model: ScheduleModel, person: Person): boolean {
  return !person.withdrawn || appointmentsOf(model, person.id).size > 0;
}

/** How many lanes a timeline view has with no filter, the "of N" in its counts. */
export function laneTotal(model: ScheduleModel, mode: "supplier" | "buyer"): number {
  const list: Person[] = mode === "supplier" ? model.suppliers : model.buyers;
  return list.filter((p) => hasLane(model, p)).length;
}

export type LaneFilters = {
  q: string;
  free: number;
  flagged: boolean;
  withdrawnOnly?: boolean;
  mostlyNeither?: boolean;
};

/**
 * The lanes a timeline view shows. A lane matches the search when the person
 * matches or anyone they meet does. `free` keeps active people with no
 * meeting in that slot (withdrawn people are never free, AGENTS.md);
 * `flagged` keeps count problems only; `withdrawnOnly` keeps lanes with a
 * meeting that involves someone who withdrew; `mostlyNeither` keeps lanes
 * where `isMostlyNeither` holds.
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
    if (!hasLane(model, p)) return false;
    const mine = appointmentsOf(model, p.id);
    if (filters.free && !isFreeIn(model, p, filters.free)) return false;
    if (filters.flagged && healthOf(p, targets) === "ok") return false;
    if (filters.withdrawnOnly && ![...mine.values()].some((a) => a.counterpartWithdrawn)) return false;
    if (filters.mostlyNeither && !isMostlyNeither(mine.values())) return false;
    if (!q || personMatches(p, q)) return true;
    for (const a of mine.values()) {
      const other = model.personById.get(mode === "supplier" ? a.buyerId : a.supplierId);
      if (other && personMatches(other, q)) return true;
    }
    return false;
  });
}

/**
 * The empty state when the filters leave no lane. The text names the filters
 * that are on ("No buyer free in slot 3 has a count problem."), so combining
 * Free in with another filter never claims the whole slot is busy.
 */
export function emptyLanesText(input: {
  mode: "supplier" | "buyer";
  free: number;
  q: string;
  flagged: boolean;
  withdrawnOnly: boolean;
  mostlyNeither: boolean;
}): { title: string; description: string } {
  const { mode, free, flagged, withdrawnOnly, mostlyNeither } = input;
  const q = input.q.trim();
  const wanted = [
    flagged ? "a count problem" : null,
    withdrawnOnly ? "a meeting with someone who withdrew" : null,
    mostlyNeither ? "mostly Neither meetings" : null,
  ].filter(Boolean);
  const noun = mode === "supplier" ? "supplier desk" : "buyer";
  if (free && !q && wanted.length === 0) {
    return {
      title: `No one free in slot ${free}`,
      description:
        mode === "supplier"
          ? `Every supplier desk is booked in slot ${free}. Open slots live with buyers below target.`
          : `Every buyer is in a meeting in slot ${free}.`,
    };
  }
  if (q && !free && wanted.length === 0) {
    return {
      title: "No matches",
      description: `Nothing matches “${q}”. Search covers supplier names, buyer organizations and titles.`,
    };
  }
  if (!q && !free && wanted.length === 0) return { title: "No matches", description: "Nobody in this view matches." };
  return {
    title: "No matches",
    description: `No ${noun}${free ? ` free in slot ${free}` : ""}${q ? ` matching “${q}”` : ""}${
      wanted.length ? ` has ${wanted.join(" and ")}` : ""
    }.`,
  };
}

/** The line in the By slot board's free list when no buyer is shown. */
export function emptyFreeBuyersText(input: { anyFree: boolean; q: string; flagged: boolean }): string {
  if (!input.anyFree) return "Every buyer has a meeting in this slot.";
  const q = input.q.trim();
  if (input.flagged) return `No free buyer${q ? " matching your search" : ""} has a count problem.`;
  return "No free buyer matches your search.";
}

/** Free in a slot: active and without a meeting then. The one rule behind the timeline filter and the slot board. */
export function isFreeIn(model: ScheduleModel, person: Person, slot: number): boolean {
  return !person.withdrawn && !appointmentsOf(model, person.id).has(slot);
}

/** Active people with no meeting in `slot`. */
export function freeIn<T extends Person>(model: ScheduleModel, list: readonly T[], slot: number): T[] {
  return list.filter((p) => isFreeIn(model, p, slot));
}

export function busyCount(model: ScheduleModel, list: readonly Person[], slot: number): number {
  return list.filter((p) => appointmentsOf(model, p.id).has(slot)).length;
}

/** Fewest meetings first, then name. Used for the free buyers lists. */
export function byFewest<T extends Person>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.count - b.count || compareNames(a.name, b.name));
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

/** "3 open slots" on the sheet. Null for a withdrawn person, whose open slots are never filled. */
export function openSlotsText(person: Person, rows: readonly SheetRow[]): string | null {
  if (person.withdrawn) return null;
  const open = rows.filter((r) => !r.appointment).length;
  return open ? `${open} open ${open === 1 ? "slot" : "slots"}` : "No open slots";
}

/**
 * The picker a sheet row opens, owned by the person whose sheet it is. An open
 * slot on a buyer's sheet lists suppliers; anything else lists buyers for the
 * supplier's slot. `replace` removes the row's buyer, so on a buyer's sheet it
 * replaces that buyer at the counterpart supplier.
 */
export function pickerRequestFor(model: ScheduleModel, person: Person, row: SheetRow, replace: boolean): PickerRequest | null {
  const slotLabel = `${row.slot.start} to ${row.slot.end}`;
  if (!row.appointment && person.kind === "buyer") {
    return { pick: "supplier", ownerId: person.id, buyerId: person.id, buyerName: personLabel(person).primary, slot: row.slot.slot, slotLabel };
  }
  const supplier = person.kind === "supplier" ? person : row.counterpart;
  if (!supplier || supplier.kind !== "supplier") return null;
  const buyer = replace && row.appointment ? model.personById.get(row.appointment.buyerId) : undefined;
  return {
    pick: "buyer",
    ownerId: person.id,
    supplierId: supplier.id,
    supplierName: supplier.name,
    slot: row.slot.slot,
    slotLabel,
    removeBuyerId: buyer?.id,
    removeBuyerName: buyer ? personLabel(buyer).primary : undefined,
  };
}

/** The open picker, if it was opened from the sheet of the person now selected. Back and Forward change `sel` alone. */
export function pickerFor(open: PickerRequest | null, sel: string | null): PickerRequest | null {
  return open && open.ownerId === sel ? open : null;
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

/** The count line in the lock confirm: who is still short of meetings, buyers and suppliers both. */
export function lockCountWarning(input: {
  buyersBelowMin: number;
  buyerMin: number;
  suppliersBelowTarget: number;
  supplierTarget: number;
}): string {
  const { buyersBelowMin, buyerMin, suppliersBelowTarget, supplierTarget } = input;
  const parts: string[] = [];
  if (buyersBelowMin) {
    parts.push(`${buyersBelowMin === 1 ? "1 buyer is" : `${buyersBelowMin} buyers are`} still below ${buyerMin} meetings.`);
  }
  if (suppliersBelowTarget) {
    parts.push(
      `${suppliersBelowTarget === 1 ? "1 supplier has" : `${suppliersBelowTarget} suppliers have`} fewer than ${supplierTarget} meetings, so ${suppliersBelowTarget === 1 ? "that desk has" : "those desks have"} open slots.`,
    );
  }
  return parts.length ? parts.join(" ") : "Every buyer and supplier is within target.";
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
  /** Appointments that still name someone who withdrew. Lock refuses until they are fixed. */
  withdrawn: WithdrawnEntry[];
  /** Manual saves on the active run still in effect (`getScheduleView`). */
  manualChanges: number;
};

/** Locked, sent, and archived events refuse edits (AGENTS.md invariants). */
export function isLockedStatus(status: WorkspaceData["status"]): boolean {
  return !eventAllows("edit", status);
}

/** One schedule edit, before it is saved: what the preview panel and the remove confirm describe. */
export type EditDraft = {
  supplierId: string;
  slot: number;
  /** The buyer leaving the slot (replace and remove). */
  removeBuyerId?: string;
  /** The buyer joining the slot (replace and add), with the counts the picker computed. */
  add?: { buyerId: string; name: string; count: number; countAfter: number };
};

export type EditPreview = {
  /** "Remove X from Hyatt, slot 4", "Add Y to Hyatt, slot 4". */
  lines: string[];
  /** Meeting counts before and after for everyone the edit touches, buyers first. */
  counts: { personId: string; name: string; before: number; after: number }[];
  /** True when a replace removes a pinned meeting: the replacement is booked unpinned (D116). */
  dropsPin: boolean;
};

/** The pin toast detail: a pin is a reviewed marker (D148); only Re-run and keep existing carries meetings forward. */
export const PIN_NOTE = "Marked as reviewed. Re-run and keep existing keeps this meeting; Run matching clears pins.";

/** Shown in the replace preview and its confirm, and what the pin toast backs up. */
export const PIN_DROP_NOTE = "This meeting is pinned. Replacing it removes the pin.";

/** The toast detail after a save: only the counts that moved ("Medtronic: 9 → 8."). Empty when none did. */
export function affectedText(affected: readonly { name: string; before: number; after: number }[]): string {
  return affected
    .filter((p) => p.before !== p.after)
    .map((p) => `${p.name}: ${p.before} → ${p.after}.`)
    .join(" ");
}

/** Describes an edit from the client model, so admins see what changes before Save. */
export function describeEdit(model: ScheduleModel, draft: EditDraft): EditPreview {
  const supplier = model.personById.get(draft.supplierId);
  const supplierName = supplier ? personLabel(supplier).primary : "the supplier";
  const lines: string[] = [];
  const counts: EditPreview["counts"] = [];
  const removed = draft.removeBuyerId ? model.personById.get(draft.removeBuyerId) : undefined;
  if (removed) {
    lines.push(`Remove ${personLabel(removed).primary} from ${supplierName}, slot ${draft.slot}`);
    counts.push({ personId: removed.id, name: personLabel(removed).primary, before: removed.count, after: removed.count - 1 });
  }
  if (draft.add) {
    lines.push(`Add ${draft.add.name} to ${supplierName}, slot ${draft.slot}`);
    counts.push({ personId: draft.add.buyerId, name: draft.add.name, before: draft.add.count, after: draft.add.countAfter });
  }
  if (supplier) {
    const delta = (draft.add ? 1 : 0) - (removed ? 1 : 0);
    if (delta !== 0) counts.push({ personId: supplier.id, name: supplierName, before: supplier.count, after: supplier.count + delta });
  }
  const kept = removed && draft.add ? appointmentsOf(model, draft.supplierId).get(draft.slot) : undefined;
  return { lines, counts, dropsPin: kept?.buyerId === removed?.id && kept?.pinned === true };
}

