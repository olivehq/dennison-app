import { count, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { events, participants, type Event } from "@/db/schema";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { eventSchema } from "@/lib/schemas/event";
import { defaultEventSettings, eventSettingsSchema } from "@/lib/schemas/event-settings";
import { recordAudit } from "@/server/audit/audit";
import { assertEventEditable } from "./editable";

const idSchema = z.uuid();

async function loadEvent(db: Db, id: unknown): Promise<ActionResult<Event>> {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return fail("not_found", "That event no longer exists.");
  const [event] = await db.select().from(events).where(eq(events.id, parsedId.data)).limit(1);
  if (!event) return fail("not_found", "That event no longer exists.");
  return ok(event);
}

export async function createEvent(
  db: Db,
  input: unknown,
  actorId: string,
): Promise<ActionResult<{ id: string }>> {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const event = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(events)
      .values({ ...parsed.data, settings: defaultEventSettings })
      .returning();
    await recordAudit(tx, {
      eventId: row.id,
      adminId: actorId,
      action: "event.create",
      entityType: "event",
      entityId: row.id,
      after: { name: row.name, eventDate: row.eventDate, timezone: row.timezone },
    });
    return row;
  });
  return ok({ id: event.id });
}

export async function updateEvent(
  db: Db,
  id: unknown,
  input: unknown,
  actorId: string,
): Promise<ActionResult<{ id: string }>> {
  const loaded = await loadEvent(db, id);
  if (!loaded.ok) return loaded;
  const event = loaded.data;
  const blocked = assertEventEditable(event);
  if (blocked) return blocked;

  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  await db.transaction(async (tx) => {
    await tx.update(events).set(parsed.data).where(eq(events.id, event.id));
    await recordAudit(tx, {
      eventId: event.id,
      adminId: actorId,
      action: "event.update",
      entityType: "event",
      entityId: event.id,
      before: { name: event.name, eventDate: event.eventDate, timezone: event.timezone },
      after: parsed.data,
    });
  });
  return ok({ id: event.id });
}

export async function updateEventSettings(
  db: Db,
  id: unknown,
  input: unknown,
  actorId: string,
): Promise<ActionResult<{ id: string }>> {
  const loaded = await loadEvent(db, id);
  if (!loaded.ok) return loaded;
  const event = loaded.data;
  const blocked = assertEventEditable(event);
  if (blocked) return blocked;

  const parsed = eventSettingsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  await db.transaction(async (tx) => {
    await tx.update(events).set({ settings: parsed.data }).where(eq(events.id, event.id));
    await recordAudit(tx, {
      eventId: event.id,
      adminId: actorId,
      action: "event.settings",
      entityType: "event",
      entityId: event.id,
      before: event.settings,
      after: parsed.data,
    });
  });
  return ok({ id: event.id });
}

/** Only a draft event with no participants can be deleted. Everything else is kept for the audit trail. */
export async function deleteEvent(db: Db, id: unknown, actorId: string): Promise<ActionResult<{ id: string }>> {
  const loaded = await loadEvent(db, id);
  if (!loaded.ok) return loaded;
  const event = loaded.data;

  if (event.status !== "draft") {
    return fail("conflict", "Only draft events can be deleted. Archive this one instead.");
  }
  const [{ value: participantCount }] = await db
    .select({ value: count() })
    .from(participants)
    .where(eq(participants.eventId, event.id));
  if (participantCount > 0) {
    return fail("conflict", "This event already has participants. Withdraw or remove them before deleting it.");
  }

  await db.transaction(async (tx) => {
    await tx.delete(events).where(eq(events.id, event.id));
    // The event row is gone, so the audit row is filed under no event.
    await recordAudit(tx, {
      eventId: null,
      adminId: actorId,
      action: "event.delete",
      entityType: "event",
      entityId: event.id,
      before: { name: event.name, eventDate: event.eventDate, timezone: event.timezone, status: event.status },
    });
  });
  return ok({ id: event.id });
}
