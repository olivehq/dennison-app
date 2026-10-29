import { and, eq } from "drizzle-orm";
import { cache } from "react";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  appointments,
  events,
  matchRuns,
  participants,
  suppliers,
  type Event,
  type Participant,
  type Supplier,
} from "@/db/schema";
import { getEvent } from "@/server/events/queries";
import { displayNameFor } from "@/server/roster/display-name";
import { slotsFor } from "./views";

/**
 * What participants see of the active schedule (scope 2.6): who meets whom in
 * which slot, with names and desks, and never rankings. One rule, applied
 * here for the participant page, the "changed since last email" hash, the
 * schedules ZIP, and the master CSV: a meeting counts only while both people
 * are active. Otherwise the slot is OPEN, or the row is left out of the master
 * list (D87, D96, D141).
 */

export type PersonRef = { type: "buyer" | "supplier"; id: string };

/** The slice of a schedule the rule reads. An `ExportView` (and so a `ScheduleView`) satisfies it. */
export type ScheduleSnapshot = {
  slots: { slot: number; start: string; end: string }[];
  buyers: { id: string; name: string; withdrawn: boolean }[];
  suppliers: { id: string; name: string; desk: number | null; withdrawn: boolean }[];
  appointments: { slot: number; buyerId: string; supplierId: string }[];
};

type SnapshotAppointment = ScheduleSnapshot["appointments"][number];

export type ParticipantSlot = {
  slot: number;
  start: string;
  end: string;
  /** Null means OPEN. `desk` is the supplier's, whichever side is viewing. */
  appointment: { counterpartId: string; counterpartName: string; desk: number | null } | null;
};

type SnapshotIndex = {
  withdrawn: Set<string>;
  buyerNames: Map<string, string>;
  suppliers: Map<string, ScheduleSnapshot["suppliers"][number]>;
  /** Live meetings by "buyer:<id>" or "supplier:<id>", then by slot. */
  booked: Map<string, Map<number, SnapshotAppointment>>;
};

// Snapshots are read-only, so each is indexed once however many people are read from it.
const indexes = new WeakMap<ScheduleSnapshot, SnapshotIndex>();

function personKey(ref: PersonRef): string {
  return `${ref.type}:${ref.id}`;
}

function indexOf(snapshot: ScheduleSnapshot): SnapshotIndex {
  const cached = indexes.get(snapshot);
  if (cached) return cached;
  const withdrawn = new Set([...snapshot.buyers, ...snapshot.suppliers].filter((p) => p.withdrawn).map((p) => p.id));
  const index: SnapshotIndex = {
    withdrawn,
    buyerNames: new Map(snapshot.buyers.map((b) => [b.id, b.name])),
    suppliers: new Map(snapshot.suppliers.map((s) => [s.id, s])),
    booked: new Map(),
  };
  const book = (key: string, a: SnapshotAppointment) => {
    if (!index.booked.has(key)) index.booked.set(key, new Map());
    index.booked.get(key)!.set(a.slot, a);
  };
  for (const a of snapshot.appointments) {
    if (withdrawn.has(a.buyerId) || withdrawn.has(a.supplierId)) continue;
    book(personKey({ type: "buyer", id: a.buyerId }), a);
    book(personKey({ type: "supplier", id: a.supplierId }), a);
  }
  indexes.set(snapshot, index);
  return index;
}

/** Whether a meeting is still on: neither the buyer nor the supplier has withdrawn. */
export function isLive(snapshot: ScheduleSnapshot, a: Pick<SnapshotAppointment, "buyerId" | "supplierId">): boolean {
  const { withdrawn } = indexOf(snapshot);
  return !withdrawn.has(a.buyerId) && !withdrawn.has(a.supplierId);
}

/** Every slot of the event for one person, in slot order, OPEN where they have no live meeting. */
export function participantSlots(snapshot: ScheduleSnapshot, person: PersonRef): ParticipantSlot[] {
  const index = indexOf(snapshot);
  const booked = index.booked.get(personKey(person));
  return snapshot.slots.map((s) => {
    const a = booked?.get(s.slot);
    if (!a) return { slot: s.slot, start: s.start, end: s.end, appointment: null };
    const supplier = index.suppliers.get(a.supplierId);
    const counterpartId = person.type === "buyer" ? a.supplierId : a.buyerId;
    const counterpartName =
      person.type === "buyer"
        ? (supplier?.name ?? "Unknown supplier")
        : (index.buyerNames.get(a.buyerId) ?? "Unknown buyer");
    return {
      slot: s.slot,
      start: s.start,
      end: s.end,
      appointment: { counterpartId, counterpartName, desk: supplier?.desk ?? null },
    };
  });
}

const uuidSchema = z.uuid();

const buyerColumns = {
  id: participants.id,
  firstName: participants.firstName,
  lastName: participants.lastName,
  organization: participants.organization,
  title: participants.title,
  displayName: participants.displayName,
  status: participants.status,
};

const supplierColumns = {
  id: suppliers.id,
  name: suppliers.name,
  deskNumber: suppliers.deskNumber,
  status: suppliers.status,
};

type BuyerRow = Pick<Participant, keyof typeof buyerColumns>;
type SupplierRow = Pick<Supplier, keyof typeof supplierColumns>;

function toBuyer(row: BuyerRow): ScheduleSnapshot["buyers"][number] {
  return { id: row.id, name: displayNameFor(row), withdrawn: row.status === "withdrawn" };
}

function toSupplier(row: SupplierRow): ScheduleSnapshot["suppliers"][number] {
  return { id: row.id, name: row.name, desk: row.deskNumber, withdrawn: row.status === "withdrawn" };
}

/** Joins an appointment to the event's active run, so one query reads "the active schedule". */
const onActiveRun = and(eq(matchRuns.id, appointments.runId), eq(matchRuns.isActive, true));

export type ActiveSchedule = ScheduleSnapshot & { event: Event };

/**
 * The event's whole active schedule in one round of four queries, with no
 * rankings, sorting, or audit reads. Memoized for the length of a Server
 * Component render, so a page that checks several counts reads it once.
 * Null when the event does not exist.
 */
export const loadActiveSchedule = cache(async (db: Db, eventId: string): Promise<ActiveSchedule | null> => {
  if (!uuidSchema.safeParse(eventId).success) return null;
  const [event, buyerRows, supplierRows, appointmentRows] = await Promise.all([
    getEvent(eventId, db),
    db.select(buyerColumns).from(participants).where(eq(participants.eventId, eventId)),
    db.select(supplierColumns).from(suppliers).where(eq(suppliers.eventId, eventId)),
    db
      .select({ slot: appointments.slot, buyerId: appointments.buyerId, supplierId: appointments.supplierId })
      .from(appointments)
      .innerJoin(matchRuns, onActiveRun)
      .where(eq(appointments.eventId, eventId)),
  ]);
  if (!event) return null;
  return {
    event,
    slots: slotsFor(event),
    buyers: buyerRows.map(toBuyer),
    suppliers: supplierRows.map(toSupplier),
    appointments: appointmentRows,
  };
});

export type PersonSchedule = {
  event: Pick<Event, "id" | "name" | "eventDate" | "timezone" | "status" | "branding">;
  person: PersonRef & { name: string; desk: number | null; withdrawn: boolean };
  slots: ParticipantSlot[];
};

function personSchedule(
  event: Event,
  person: PersonSchedule["person"],
  snapshot: Omit<ScheduleSnapshot, "slots">,
): PersonSchedule {
  const { id, name, eventDate, timezone, status, branding } = event;
  return {
    event: { id, name, eventDate, timezone, status, branding },
    person,
    slots: participantSlots({ ...snapshot, slots: slotsFor(event) }, person),
  };
}

/**
 * One person's slots, read with two queries run together: the person with
 * their event, and their meetings on the active run joined to the other side.
 * Null when the event or the person does not exist. Withdrawn people come
 * back flagged; callers decide what to show them.
 */
export async function loadPersonSchedule(db: Db, eventId: string, ref: PersonRef): Promise<PersonSchedule | null> {
  if (!uuidSchema.safeParse(eventId).success || !uuidSchema.safeParse(ref.id).success) return null;
  const meetingColumns = { slot: appointments.slot, buyerId: appointments.buyerId, supplierId: appointments.supplierId };

  if (ref.type === "buyer") {
    const [[found], meetings] = await Promise.all([
      db
        .select({ event: events, person: buyerColumns })
        .from(participants)
        .innerJoin(events, eq(events.id, participants.eventId))
        .where(and(eq(participants.id, ref.id), eq(participants.eventId, eventId)))
        .limit(1),
      db
        .select({ ...meetingColumns, counterpart: supplierColumns })
        .from(appointments)
        .innerJoin(matchRuns, onActiveRun)
        .innerJoin(suppliers, eq(suppliers.id, appointments.supplierId))
        .where(and(eq(appointments.eventId, eventId), eq(appointments.buyerId, ref.id))),
    ]);
    if (!found) return null;
    const buyer = toBuyer(found.person);
    return personSchedule(
      found.event,
      { type: "buyer", ...buyer, desk: null },
      {
        buyers: [buyer],
        suppliers: meetings.map((m) => toSupplier(m.counterpart)),
        appointments: meetings,
      },
    );
  }

  const [[found], meetings] = await Promise.all([
    db
      .select({ event: events, person: supplierColumns })
      .from(suppliers)
      .innerJoin(events, eq(events.id, suppliers.eventId))
      .where(and(eq(suppliers.id, ref.id), eq(suppliers.eventId, eventId)))
      .limit(1),
    db
      .select({ ...meetingColumns, counterpart: buyerColumns })
      .from(appointments)
      .innerJoin(matchRuns, onActiveRun)
      .innerJoin(participants, eq(participants.id, appointments.buyerId))
      .where(and(eq(appointments.eventId, eventId), eq(appointments.supplierId, ref.id))),
  ]);
  if (!found) return null;
  const supplier = toSupplier(found.person);
  return personSchedule(
    found.event,
    { type: "supplier", ...supplier },
    {
      buyers: meetings.map((m) => toBuyer(m.counterpart)),
      suppliers: [supplier],
      appointments: meetings,
    },
  );
}
