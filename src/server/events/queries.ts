import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { appointments, events, matchRuns, participants, suppliers, type Event } from "@/db/schema";

const uuidSchema = z.uuid();

export type EventListItem = Event & {
  participantCount: number;
  supplierCount: number;
};

/** Every event, newest show date first, with active roster counts. */
export async function listEvents(db: Db = getDb()): Promise<EventListItem[]> {
  const participantCount = db
    .select({ value: count() })
    .from(participants)
    .where(and(eq(participants.eventId, events.id), eq(participants.status, "active")));
  const supplierCount = db
    .select({ value: count() })
    .from(suppliers)
    .where(and(eq(suppliers.eventId, events.id), eq(suppliers.status, "active")));

  const rows = await db
    .select({
      event: events,
      participantCount: sql<number>`(${participantCount})`.mapWith(Number),
      supplierCount: sql<number>`(${supplierCount})`.mapWith(Number),
    })
    .from(events)
    .orderBy(desc(events.eventDate), desc(events.createdAt));

  return rows.map((row) => ({
    ...row.event,
    participantCount: row.participantCount,
    supplierCount: row.supplierCount,
  }));
}

/** The event, or null when the id is unknown or not a uuid. */
export async function getEvent(id: string, db: Db = getDb()): Promise<Event | null> {
  if (!uuidSchema.safeParse(id).success) return null;
  const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return event ?? null;
}

export class EventNotFoundError extends Error {
  constructor(id: string) {
    super(`Event ${id} not found`);
    this.name = "EventNotFoundError";
  }
}

export async function getEventOrThrow(id: string, db: Db = getDb()): Promise<Event> {
  const event = await getEvent(id, db);
  if (!event) throw new EventNotFoundError(id);
  return event;
}

export type EventCounts = {
  participants: number;
  suppliers: number;
  /** Appointments in the active match run. Zero when no run is active. */
  appointments: number;
  activeRunId: string | null;
};

export async function getEventCounts(id: string, db: Db = getDb()): Promise<EventCounts> {
  const [[participantRow], [supplierRow], [activeRun]] = await Promise.all([
    db
      .select({ value: count() })
      .from(participants)
      .where(and(eq(participants.eventId, id), eq(participants.status, "active"))),
    db
      .select({ value: count() })
      .from(suppliers)
      .where(and(eq(suppliers.eventId, id), eq(suppliers.status, "active"))),
    db
      .select({ id: matchRuns.id })
      .from(matchRuns)
      .where(and(eq(matchRuns.eventId, id), eq(matchRuns.isActive, true)))
      .limit(1),
  ]);

  let appointmentCount = 0;
  if (activeRun) {
    const [row] = await db
      .select({ value: count() })
      .from(appointments)
      .where(eq(appointments.runId, activeRun.id));
    appointmentCount = row?.value ?? 0;
  }

  return {
    participants: participantRow?.value ?? 0,
    suppliers: supplierRow?.value ?? 0,
    appointments: appointmentCount,
    activeRunId: activeRun?.id ?? null,
  };
}
