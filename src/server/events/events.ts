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

  // retainData only changes through setRetainData, so a stale settings form can't flip it.
  const settings = { ...parsed.data, retainData: event.settings.retainData ?? false };
  await db.transaction(async (tx) => {
    await tx.update(events).set({ settings }).where(eq(events.id, event.id));
    await recordAudit(tx, {
      eventId: event.id,
      adminId: actorId,
      action: "event.settings",
      entityType: "event",
      entityId: event.id,
      before: event.settings,
      after: settings,
    });
  });
  return ok({ id: event.id });
}

/**
 * "Keep participant data after 90 days" (SOW 4). Allowed in every status
 * except archived, because D&A usually asks after the show, when the event is
 * locked or sent. An archived event's data is already gone.
 */
export async function setRetainData(
  db: Db,
  id: unknown,
  retain: unknown,
  actorId: string,
): Promise<ActionResult<{ id: string; retainData: boolean }>> {
  const loaded = await loadEvent(db, id);
  if (!loaded.ok) return loaded;
  const event = loaded.data;
  const parsed = z.boolean().safeParse(retain);
  if (!parsed.success) return fail("validation", "Choose whether to keep the data.");
  if (event.status === "archived") {
    return fail("locked", "This event is archived. Its participant data has already been deleted.");
  }
  const current = event.settings.retainData ?? false;
  if (current === parsed.data) return ok({ id: event.id, retainData: current });

  await db.transaction(async (tx) => {
    await tx
      .update(events)
      .set({ settings: { ...event.settings, retainData: parsed.data } })
      .where(eq(events.id, event.id));
    await recordAudit(tx, {
      eventId: event.id,
      adminId: actorId,
      action: "event.retention",
      entityType: "event",
      entityId: event.id,
      before: { retainData: current },
      after: { retainData: parsed.data },
    });
  });
  return ok({ id: event.id, retainData: parsed.data });
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
