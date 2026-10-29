import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { appointments, auditEvents, events, participants, suppliers, type Event } from "@/db/schema";
import { findActiveRun } from "@/server/matching/runs";
import { cachePerRender } from "@/server/render-cache";

const uuidSchema = z.uuid();

export type EventListItem = Event & {
  participantCount: number;
  supplierCount: number;
};

/** Every event, newest show date first, with active roster counts. Shared per render. */
export function listEvents(db: Db = getDb()): Promise<EventListItem[]> {
  return listEventsCached(db);
}

const listEventsCached = cachePerRender(async (db: Db): Promise<EventListItem[]> => {
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
});

export type EventSummary = Pick<Event, "id" | "name" | "eventDate" | "timezone" | "status">;

/** Every event without counts or settings, for the sidebar's switcher and recent list. Shared per render. */
export function listEventSummaries(db: Db = getDb()): Promise<EventSummary[]> {
  return listEventSummariesCached(db);
}

const listEventSummariesCached = cachePerRender(
  (db: Db): Promise<EventSummary[]> =>
    db
      .select({
        id: events.id,
        name: events.name,
        eventDate: events.eventDate,
        timezone: events.timezone,
        status: events.status,
      })
      .from(events)
      .orderBy(desc(events.eventDate), desc(events.createdAt)),
);

/** The event, or null when the id is unknown or not a uuid. Shared per render. */
export function getEvent(id: string, db: Db = getDb()): Promise<Event | null> {
  return getEventCached(db, id);
}

const getEventCached = cachePerRender(async (db: Db, id: string): Promise<Event | null> => {
  if (!uuidSchema.safeParse(id).success) return null;
  const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return event ?? null;
});

/**
 * Whether the retention job has deleted this event's participant data. An
 * admin can archive an event by hand, so archived alone doesn't mean deleted.
 */
export async function wasParticipantDataDeleted(eventId: string, db: Db = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.eventId, eventId), eq(auditEvents.action, "event.retention_delete")))
    .limit(1);
  return row !== undefined;
}

export type EventCounts = {
  participants: number;
  suppliers: number;
  /** Appointments in the active match run. Zero when no run is active. */
  appointments: number;
  activeRunId: string | null;
};

/**
 * Active buyers and suppliers of the event, shared per render, so the
 * overview's counts and the matching readiness on one page count them once.
 */
export const countActiveRoster = cachePerRender(
  async (db: Db, eventId: string): Promise<{ participants: number; suppliers: number }> => {
    const [[participantRow], [supplierRow]] = await Promise.all([
      db
        .select({ value: count() })
        .from(participants)
        .where(and(eq(participants.eventId, eventId), eq(participants.status, "active"))),
      db
        .select({ value: count() })
        .from(suppliers)
        .where(and(eq(suppliers.eventId, eventId), eq(suppliers.status, "active"))),
    ]);
    return { participants: Number(participantRow?.value ?? 0), suppliers: Number(supplierRow?.value ?? 0) };
  },
);

export async function getEventCounts(id: string, db: Db = getDb()): Promise<EventCounts> {
  // The active run is the one the layout already read in this render.
  const [roster, activeRun] = await Promise.all([countActiveRoster(db, id), findActiveRun(db, id)]);

  let appointmentCount = 0;
  if (activeRun) {
    const [row] = await db
      .select({ value: count() })
      .from(appointments)
      .where(eq(appointments.runId, activeRun.id));
    appointmentCount = row?.value ?? 0;
  }

  return {
    ...roster,
    appointments: appointmentCount,
    activeRunId: activeRun?.id ?? null,
  };
}
