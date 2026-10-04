import { and, count, eq, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { events, participants, type Event } from "@/db/schema";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { eventSchema } from "@/lib/schemas/event";
import { defaultEventSettings, eventSettingsSchema } from "@/lib/schemas/event-settings";
import { recordAudit } from "@/server/audit/audit";
import { assertEventEditable, EventChangedError, eventChangedResult, READ_ONLY_STATUSES } from "./editable";

const idSchema = z.uuid();

/** Matches the event only while it is still editable: the compare half of a compare-and-set. */
function editableEvent(id: string) {
  return and(eq(events.id, id), notInArray(events.status, [...READ_ONLY_STATUSES]));
}

/** Runs `work` in a transaction, turning `EventChangedError` into the conflict result. */
async function inTransaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await db.transaction(work));
  } catch (error) {
    const changed = eventChangedResult(error);
    if (changed) return changed;
    throw error;
  }
}

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

  const done = await inTransaction(db, async (tx) => {
    const changed = await tx.update(events).set(parsed.data).where(editableEvent(event.id)).returning({ id: events.id });
    if (changed.length === 0) throw new EventChangedError();
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
  if (!done.ok) return done;
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
  const done = await inTransaction(db, async (tx) => {
    const changed = await tx.update(events).set({ settings }).where(editableEvent(event.id)).returning({ id: events.id });
    if (changed.length === 0) throw new EventChangedError();
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
  if (!done.ok) return done;
  return ok({ id: event.id });
}

/**
 * "Keep participant data after 90 days" (SOW 4). Allowed in every status
 * except archived, because D&A usually asks after the show, when the event is
 * locked or sent. Archived events refuse every change, this one included.
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
    return fail("locked", "This event is archived, so its retention setting can't change.");
  }
  const current = event.settings.retainData ?? false;
  if (current === parsed.data) return ok({ id: event.id, retainData: current });

  const done = await inTransaction(db, async (tx) => {
    const changed = await tx
      .update(events)
      .set({ settings: { ...event.settings, retainData: parsed.data } })
      .where(and(eq(events.id, event.id), ne(events.status, "archived")))
      .returning({ id: events.id });
    if (changed.length === 0) throw new EventChangedError();
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
  if (!done.ok) return done;
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
  const done = await inTransaction(db, async (tx) => {
    // Lock the row while it is still a draft, then count, so a participant
    // added or a status change in between can't slip past the checks.
    const [draft] = await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, event.id), eq(events.status, "draft")))
      .for("update");
    if (!draft) throw new EventChangedError();
    const [{ value: participantCount }] = await tx
      .select({ value: count() })
      .from(participants)
      .where(eq(participants.eventId, event.id));
    if (participantCount > 0) return false;
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
    return true;
  });
  if (!done.ok) return done;
  if (!done.data) {
    return fail("conflict", "This event already has participants. Withdraw or remove them before deleting it.");
  }
  return ok({ id: event.id });
}

/**
 * Archives an event from any status (the "Archive event" button). Archived
 * events refuse every change; exports still work. A compare-and-set on the
 * status read here, so the audit row's `before` is the status it replaced.
 * Participant data stays until the retention job (D69) or D&A asks.
 */
export async function archiveEvent(
  db: Db,
  input: { eventId: unknown; adminId: string },
): Promise<ActionResult<{ id: string }>> {
  const loaded = await loadEvent(db, input.eventId);
  if (!loaded.ok) return loaded;
  const event = loaded.data;
  if (event.status === "archived") return fail("conflict", "This event is already archived.");

  const done = await inTransaction(db, async (tx) => {
    const changed = await tx
      .update(events)
      .set({ status: "archived" })
      .where(and(eq(events.id, event.id), eq(events.status, event.status)))
      .returning({ id: events.id });
    if (changed.length === 0) throw new EventChangedError();
    await recordAudit(tx, {
      eventId: event.id,
      adminId: input.adminId,
      action: "event.archive",
      entityType: "event",
      entityId: event.id,
      before: { status: event.status },
      after: { status: "archived" },
    });
  });
  if (!done.ok) return done;
  return ok({ id: event.id });
}
