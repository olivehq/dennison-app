import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { appointments, auditEvents, type Appointment, type Event, type Participant, type Supplier } from "@/db/schema";
import { isTopN, type QualityStats } from "@/engine";
import { formatMinutes } from "@/lib/time";
import { compareNames } from "@/lib/names";
import { displayNameFor } from "@/server/roster/display-name";
import { loadRoster, type Roster } from "@/server/matching/input";
import { readStats } from "@/server/matching/queries";
import { findActiveRun } from "@/server/matching/runs";
import { UNDO_NOTE_PREFIX } from "./undo-note";

/**
 * Reads for the schedule workspace and the participant page. Everything is
 * computed from the event's active run.
 */

export type MatchStrength = "mutual" | "buyer" | "supplier" | "neither" | "blank";

/** How the two sides ranked each other, against the event's mutualTopN. */
export function matchStrength(
  buyerRank: number | null,
  supplierRank: number | null,
  mutualTopN: number,
): MatchStrength {
  if (buyerRank === null || supplierRank === null) return "blank";
  const b = isTopN(buyerRank, mutualTopN);
  const s = isTopN(supplierRank, mutualTopN);
  if (b && s) return "mutual";
  if (b) return "buyer";
  if (s) return "supplier";
  return "neither";
}

export type ScheduleSlot = {
  slot: number;
  startMinutes: number;
  endMinutes: number;
  /** "3:10 PM", in the event timezone (D16). */
  start: string;
  end: string;
};

export type ScheduleSupplier = {
  id: string;
  name: string;
  type: Supplier["type"];
  desk: number | null;
  count: number;
  withdrawn: boolean;
};

export type ScheduleBuyer = {
  id: string;
  name: string;
  organization: string | null;
  title: string | null;
  count: number;
  biztechOptIn: boolean;
  withdrawn: boolean;
};

export type ScheduleAppointment = {
  id: string;
  slot: number;
  buyerId: string;
  supplierId: string;
  buyerRank: number | null;
  supplierRank: number | null;
  source: Appointment["source"];
  pinned: boolean;
  mutualTopN: boolean;
  strength: MatchStrength;
  /** The buyer or the supplier withdrew after this was booked. Locking is refused until it is fixed. */
  counterpartWithdrawn: boolean;
};

export type HealthEntry = { id: string; name: string; count: number };

/** An appointment that still names someone who withdrew. */
export type WithdrawnEntry = {
  appointmentId: string;
  slot: number;
  buyerId: string;
  supplierId: string;
  buyerName: string;
  supplierName: string;
  /** The person (or people) who withdrew. */
  withdrawnIds: string[];
};

export type ScheduleHealth = {
  buyersBelowMin: HealthEntry[];
  buyersAboveMax: HealthEntry[];
  suppliersOffTarget: HealthEntry[];
  /** "Needs attention: withdrawn". Slot order. */
  withdrawn: WithdrawnEntry[];
};

export type ScheduleRun = {
  id: string;
  version: number;
  stats: QualityStats | null;
  warnings: string[];
  parentRunId: string | null;
  createdAt: Date;
};

export type ScheduleView = {
  event: Event;
  /** Null until a run has been activated. */
  run: ScheduleRun | null;
  slots: ScheduleSlot[];
  suppliers: ScheduleSupplier[];
  buyers: ScheduleBuyer[];
  appointments: ScheduleAppointment[];
  health: ScheduleHealth;
  /** Manual replace, add, and remove saves on the active run that are still in effect (undone ones excluded). */
  manualChanges: number;
};

export function slotsFor(event: Pick<Event, "settings">): ScheduleSlot[] {
  return event.settings.slots.map((s) => ({
    slot: s.n,
    startMinutes: s.startMinutes,
    endMinutes: s.endMinutes,
    start: formatMinutes(s.startMinutes),
    end: formatMinutes(s.endMinutes),
  }));
}

function countBy(rows: Appointment[], pick: (a: Appointment) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = pick(row);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function toHealth(entries: { id: string; count: number }[] | undefined, names: Map<string, string>): HealthEntry[] {
  return (entries ?? []).map((e) => ({ id: e.id, name: names.get(e.id) ?? e.id, count: e.count }));
}

const MANUAL_EDIT_ACTIONS = ["appointment.replace", "appointment.add", "appointment.remove"] as const;

function snapshotRunId(value: unknown): string | null {
  if (value && typeof value === "object" && "runId" in value && typeof value.runId === "string") return value.runId;
  return null;
}

/**
 * Manual edits on the run still in effect: replace, add, and remove rows on
 * that run, minus the ones undone. An undo can itself be undone (D32), so an
 * edit counts when it has no undo, or its undo was undone, and so on.
 */
export async function countManualChanges(db: Db, eventId: string, runId: string): Promise<number> {
  const rows = await db
    .select({ id: auditEvents.id, action: auditEvents.action, before: auditEvents.before, after: auditEvents.after, note: auditEvents.note })
    .from(auditEvents)
    .where(and(eq(auditEvents.eventId, eventId), inArray(auditEvents.action, [...MANUAL_EDIT_ACTIONS, "appointment.undo"])));
  const onRun = rows.filter((r) => (snapshotRunId(r.before) ?? snapshotRunId(r.after)) === runId);
  const undoneBy = new Map<string, string>();
  for (const r of onRun) {
    if (r.action !== "appointment.undo" || !r.note) continue;
    const target = r.note.startsWith(UNDO_NOTE_PREFIX) ? r.note.slice(UNDO_NOTE_PREFIX.length) : null;
    if (target) undoneBy.set(target, r.id);
  }
  const inEffect = (id: string, depth = 0): boolean => {
    const undo = undoneBy.get(id);
    return undo === undefined || depth > 50 || !inEffect(undo, depth + 1);
  };
  return onRun.filter((r) => r.action !== "appointment.undo" && inEffect(r.id)).length;
}

async function loadActiveAppointments(db: Db, eventId: string) {
  const run = await findActiveRun(db, eventId);
  if (!run) return { run: null, rows: [] as Appointment[] };
  const rows = await db.select().from(appointments).where(eq(appointments.runId, run.id));
  return { run, rows };
}

/** Everything the workspace page needs in one call. Null when the event does not exist. */
export async function getScheduleView(eventId: string, db: Db = getDb()): Promise<ScheduleView | null> {
  const roster = await loadRoster(db, eventId);
  if (!roster) return null;
  const { run, rows } = await loadActiveAppointments(db, eventId);
  const n = roster.event.settings.mutualTopN;
  const buyerCounts = countBy(rows, (a) => a.buyerId);
  const supplierCounts = countBy(rows, (a) => a.supplierId);
  const stats = run ? readStats(run.stats) : null;

  const suppliers: ScheduleSupplier[] = roster.suppliers
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      desk: s.deskNumber,
      count: supplierCounts.get(s.id) ?? 0,
      withdrawn: s.status === "withdrawn",
    }))
    .sort((a, b) => compareNames(a.name, b.name));

  const buyers: ScheduleBuyer[] = roster.participants
    .map((p) => ({
      id: p.id,
      name: displayNameFor(p),
      organization: p.organization,
      title: p.title,
      count: buyerCounts.get(p.id) ?? 0,
      biztechOptIn: p.biztechOptIn,
      withdrawn: p.status === "withdrawn",
    }))
    .sort((a, b) => compareNames(a.name, b.name));

  const withdrawnIds = new Set([...buyers.filter((b) => b.withdrawn), ...suppliers.filter((x) => x.withdrawn)].map((p) => p.id));
  const views: ScheduleAppointment[] = rows
    .map((a) => {
      const strength = matchStrength(a.buyerRank, a.supplierRank, n);
      return {
        id: a.id,
        slot: a.slot,
        buyerId: a.buyerId,
        supplierId: a.supplierId,
        buyerRank: a.buyerRank,
        supplierRank: a.supplierRank,
        source: a.source,
        pinned: a.pinned,
        mutualTopN: strength === "mutual",
        strength,
        counterpartWithdrawn: withdrawnIds.has(a.buyerId) || withdrawnIds.has(a.supplierId),
      };
    })
    .sort(
      (a, b) =>
        a.slot - b.slot ||
        compareNames(roster.names.get(a.supplierId) ?? "", roster.names.get(b.supplierId) ?? "") ||
        compareNames(roster.names.get(a.buyerId) ?? "", roster.names.get(b.buyerId) ?? ""),
    );

  const name = (id: string) => roster.names.get(id) ?? id;
  const withdrawn: WithdrawnEntry[] = views
    .filter((a) => a.counterpartWithdrawn)
    .map((a) => ({
      appointmentId: a.id,
      slot: a.slot,
      buyerId: a.buyerId,
      supplierId: a.supplierId,
      buyerName: name(a.buyerId),
      supplierName: name(a.supplierId),
      withdrawnIds: [a.buyerId, a.supplierId].filter((id) => withdrawnIds.has(id)),
    }));
  const manualChanges = run ? await countManualChanges(db, eventId, run.id) : 0;

  return {
    event: roster.event,
    run: run
      ? {
          id: run.id,
          version: run.version,
          stats,
          warnings: run.warnings,
          parentRunId: run.parentRunId,
          createdAt: run.createdAt,
        }
      : null,
    slots: slotsFor(roster.event),
    suppliers,
    buyers,
    appointments: views,
    health: {
      buyersBelowMin: toHealth(stats?.buyersBelowMin, roster.names),
      buyersAboveMax: toHealth(stats?.buyersAboveMax, roster.names),
      suppliersOffTarget: toHealth(stats?.suppliersOffTarget, roster.names),
      withdrawn,
    },
    manualChanges,
  };
}

export type PersonRef = { type: "buyer" | "supplier"; id: string };

export type PersonSlotAppointment = {
  id: string;
  counterpartId: string;
  counterpartName: string;
  /** The supplier's desk, whichever side is viewing. */
  desk: number | null;
  /**
   * The other side withdrew after this was booked. Admin view only, so staff
   * can fix it; a participant sees the slot as OPEN instead.
   */
  counterpartWithdrawn?: boolean;
  /** Absent when built for a participant; nothing on that page shows rankings. */
  buyerRank?: number | null;
  supplierRank?: number | null;
  strength?: MatchStrength;
};

export type PersonScheduleSlot = {
  slot: number;
  start: string;
  end: string;
  /** Null means OPEN. */
  appointment: PersonSlotAppointment | null;
};

export type PersonSchedule = {
  event: { id: string; name: string; eventDate: string; timezone: string; status: Event["status"] };
  person: {
    id: string;
    type: "buyer" | "supplier";
    name: string;
    desk: number | null;
    organization: string | null;
    title: string | null;
    withdrawn: boolean;
  };
  slots: PersonScheduleSlot[];
};

function findPerson(roster: Roster, ref: PersonRef): Participant | Supplier | null {
  if (ref.type === "buyer") return roster.participants.find((p) => p.id === ref.id) ?? null;
  return roster.suppliers.find((s) => s.id === ref.id) ?? null;
}

/**
 * One person's slots with OPEN gaps explicit. Used by the detail sheet and,
 * with `forParticipant`, by `/s/[token]`, which must never see ranks.
 */
export async function getPersonSchedule(
  eventId: string,
  ref: PersonRef & { forParticipant?: boolean },
  db: Db = getDb(),
): Promise<PersonSchedule | null> {
  const roster = await loadRoster(db, eventId);
  if (!roster) return null;
  const person = findPerson(roster, ref);
  if (!person) return null;
  const { rows } = await loadActiveAppointments(db, eventId);
  const supplierById = new Map(roster.suppliers.map((s) => [s.id, s]));
  const mine = rows.filter((a) => (ref.type === "buyer" ? a.buyerId : a.supplierId) === ref.id);
  const bySlot = new Map(mine.map((a) => [a.slot, a]));
  const n = roster.event.settings.mutualTopN;

  const statusById = new Map<string, string>([
    ...roster.participants.map((p): [string, string] => [p.id, p.status]),
    ...roster.suppliers.map((x): [string, string] => [x.id, x.status]),
  ]);

  const slots: PersonScheduleSlot[] = slotsFor(roster.event).map((s) => {
    const a = bySlot.get(s.slot);
    if (!a) return { slot: s.slot, start: s.start, end: s.end, appointment: null };
    const counterpartId = ref.type === "buyer" ? a.supplierId : a.buyerId;
    const counterpartWithdrawn = statusById.get(counterpartId) === "withdrawn";
    // Nobody will be at that meeting, so the participant sees a free slot.
    if (counterpartWithdrawn && ref.forParticipant) return { slot: s.slot, start: s.start, end: s.end, appointment: null };
    const appointment: PersonSlotAppointment = {
      id: a.id,
      counterpartId,
      counterpartName: roster.names.get(counterpartId) ?? "Unknown",
      desk: supplierById.get(a.supplierId)?.deskNumber ?? null,
    };
    if (!ref.forParticipant) {
      appointment.counterpartWithdrawn = counterpartWithdrawn;
      appointment.buyerRank = a.buyerRank;
      appointment.supplierRank = a.supplierRank;
      appointment.strength = matchStrength(a.buyerRank, a.supplierRank, n);
    }
    return { slot: s.slot, start: s.start, end: s.end, appointment };
  });

  const isBuyer = ref.type === "buyer";
  const buyer = isBuyer ? (person as Participant) : null;
  const supplier = isBuyer ? null : (person as Supplier);
  return {
    event: {
      id: roster.event.id,
      name: roster.event.name,
      eventDate: roster.event.eventDate,
      timezone: roster.event.timezone,
      status: roster.event.status,
    },
    person: {
      id: person.id,
      type: ref.type,
      name: roster.names.get(person.id) ?? "",
      desk: supplier?.deskNumber ?? null,
      organization: buyer?.organization ?? null,
      title: buyer?.title ?? null,
      withdrawn: person.status === "withdrawn",
    },
    slots,
  };
}
