import { and, count, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { appointments, events, imports, matchRuns, participants, type Event } from "@/db/schema";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { eventSchema, type EventInput } from "@/lib/schemas/event";
import { defaultEventSettings, eventSettingsSchema, type EventSettings } from "@/lib/schemas/event-settings";
import { recordAudit } from "@/server/audit/audit";
import { deleteQueuedFilesNow, queueFileDeletions } from "@/server/files/cleanup";
import { EventChangedError, inEventTransaction, Refused } from "./editable";
import { advanceStatus, hasSendInProgress, SEND_IN_PROGRESS_MESSAGE } from "./status";

const idSchema = z.uuid();

/** The highest slot number used by the event's active run, or null without one. */
async function highestActiveSlot(db: Db, eventId: string): Promise<number | null> {
  const [row] = await db
    .select({ value: max(appointments.slot) })
    .from(appointments)
    .innerJoin(matchRuns, eq(matchRuns.id, appointments.runId))
    .where(and(eq(matchRuns.eventId, eventId), eq(matchRuns.isActive, true)));
  return row?.value ?? null;
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

/** Writes the event's name, date, and timezone. Call it under `inEventTransaction`'s `edit` claim. */
async function writeDetails(tx: Db, event: Event, details: EventInput, actorId: string): Promise<void> {
  await tx.update(events).set(details).where(eq(events.id, event.id));
  await recordAudit(tx, {
    eventId: event.id,
    adminId: actorId,
    action: "event.update",
    entityType: "event",
    entityId: event.id,
    before: { name: event.name, eventDate: event.eventDate, timezone: event.timezone },
    after: details,
  });
}

/** Returned with code `needs_schedule_reset` when fewer slots would cut into the active schedule. */
export function scheduleResetMessage(highestSlot: number): string {
  return `The active schedule uses slot ${highestSlot}. Saving clears the active schedule so you can run matching again with the new settings. Your earlier runs stay in the list.`;
}

/**
 * Writes submitted settings under the event row lock (D98). A `slotCount`
 * below the highest slot the active run uses is refused with code
 * `needs_schedule_reset`, unless `clearSchedule` is set: then the active run
 * is deactivated in the same transaction (no run is active, and a `matched`
 * event goes back to `imported`), so the admin can run matching again with
 * the new settings. Earlier runs stay in the list. `event` is the row as
 * `inEventTransaction` claimed it, so the merge keeps a concurrent setRetainData.
 */
async function writeSettings(
  tx: Db,
  event: Event,
  submitted: Partial<EventSettings>,
  actorId: string,
  clearSchedule: boolean,
): Promise<{ clearedRunId: string | null }> {
  let clearedRunId: string | null = null;
  // Fewer slots than the active schedule uses would orphan its appointments.
  const highest = await highestActiveSlot(tx, event.id);
  if (highest !== null && submitted.slotCount! < highest) {
    if (!clearSchedule) {
      throw new Refused(
        fail("needs_schedule_reset", scheduleResetMessage(highest), {
          slotCount: [`The active schedule uses slot ${highest}. Keep at least ${highest} slots, or save and clear the schedule.`],
        }),
      );
    }
    const [cleared] = await tx
      .update(matchRuns)
      .set({ isActive: false })
      .where(and(eq(matchRuns.eventId, event.id), eq(matchRuns.isActive, true)))
      .returning({ id: matchRuns.id });
    clearedRunId = cleared.id;
    // A cleared schedule is not "matched" any more. Locked and sent events never get here.
    await advanceStatus(tx, event.id, "matched", "imported");
    await recordAudit(tx, {
      eventId: event.id,
      adminId: actorId,
      action: "matching.clear",
      entityType: "match_run",
      entityId: clearedRunId,
      before: { activeRunId: clearedRunId, highestSlot: highest },
      after: { activeRunId: null, slotCount: submitted.slotCount },
    });
  }
  const settings: EventSettings = { ...event.settings, ...submitted };
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
  return { clearedRunId };
}

/** retainData only changes through setRetainData, so a stale settings form can't flip it. */
function withoutRetainData(settings: EventSettings): Partial<EventSettings> {
  const submitted: Partial<EventSettings> = { ...settings };
  delete submitted.retainData;
  return submitted;
}

/** A failure's field errors with `prefix` in front of every key, or undefined when it has none. */
function fieldErrorsOf(result: ActionResult<unknown>, prefix: string): Record<string, string[]> | undefined {
  if (result.ok || !result.error.fieldErrors) return undefined;
  return Object.fromEntries(Object.entries(result.error.fieldErrors).map(([key, value]) => [`${prefix}${key}`, value]));
}

export async function updateEvent(
  db: Db,
  id: unknown,
  input: unknown,
  actorId: string,
): Promise<ActionResult<{ id: string }>> {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return fail("not_found", "That event no longer exists.");

  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const done = await inEventTransaction(db, parsedId.data, "edit", (tx, current) => writeDetails(tx, current, parsed.data, actorId));
  if (!done.ok) return done;
  return ok({ id: parsedId.data });
}

export async function updateEventSettings(
  db: Db,
  id: unknown,
  input: unknown,
  actorId: string,
  options: { clearSchedule?: boolean } = {},
): Promise<ActionResult<{ id: string; clearedRunId: string | null }>> {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return fail("not_found", "That event no longer exists.");

  const parsed = eventSettingsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const done = await inEventTransaction(db, parsedId.data, "edit", (tx, current) =>
    writeSettings(tx, current, withoutRetainData(parsed.data), actorId, options.clearSchedule ?? false),
  );
  if (!done.ok) return done;
  return ok({ id: parsedId.data, clearedRunId: done.data.clearedRunId });
}

export type SaveEventFormInput = {
  /** Name, date, and timezone. Omitted when the form did not change them. */
  details?: unknown;
  /** Every setting. Omitted when the form did not change them. */
  settings?: unknown;
  /** The admin confirmed clearing the active schedule for fewer slots. */
  clearSchedule?: boolean;
};

/**
 * The settings page's save: details and settings in one transaction, so they
 * succeed or fail together. Field errors are keyed by form path: details keys
 * as they are ("name"), settings keys under "settings." ("settings.slotCount").
 */
export async function saveEventForm(
  db: Db,
  id: unknown,
  input: SaveEventFormInput,
  actorId: string,
): Promise<ActionResult<{ id: string; clearedRunId: string | null }>> {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return fail("not_found", "That event no longer exists.");
  if (input.details === undefined && input.settings === undefined) {
    return fail("validation", "Nothing to save. Change a value first.");
  }

  const details = input.details === undefined ? null : eventSchema.safeParse(input.details);
  const settings = input.settings === undefined ? null : eventSettingsSchema.safeParse(input.settings);
  const fieldErrors: Record<string, string[]> = {};
  if (details && !details.success) Object.assign(fieldErrors, fieldErrorsOf(fromZod(details.error), ""));
  if (settings && !settings.success) Object.assign(fieldErrors, fieldErrorsOf(fromZod(settings.error), "settings."));
  if (Object.keys(fieldErrors).length > 0) return fail("validation", "Check the highlighted fields.", fieldErrors);

  const done = await inEventTransaction(db, parsedId.data, "edit", async (tx, current) => {
    const saved = settings?.success
      ? await writeSettings(tx, current, withoutRetainData(settings.data), actorId, input.clearSchedule ?? false)
      : { clearedRunId: null };
    if (details?.success) await writeDetails(tx, current, details.data, actorId);
    return saved;
  });
  if (!done.ok) {
    const errors = fieldErrorsOf(done, "settings.");
    return errors ? fail(done.error.code, done.error.message, errors) : done;
  }
  return ok({ id: parsedId.data, clearedRunId: done.data.clearedRunId });
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
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return fail("not_found", "That event no longer exists.");
  const parsed = z.boolean().safeParse(retain);
  if (!parsed.success) return fail("validation", "Choose whether to keep the data.");

  // The only writer of retainData: lock the row and change that one key of
  // the stored settings, so a concurrent settings save is kept.
  const done = await inEventTransaction(db, parsedId.data, "unarchived", async (tx, row) => {
    const stored = row.settings.retainData ?? false;
    if (stored === parsed.data) return;
    await tx.update(events).set({ settings: { ...row.settings, retainData: parsed.data } }).where(eq(events.id, parsedId.data));
    await recordAudit(tx, {
      eventId: parsedId.data,
      adminId: actorId,
      action: "event.retention",
      entityType: "event",
      entityId: parsedId.data,
      before: { retainData: stored },
      after: { retainData: parsed.data },
    });
  });
  if (!done.ok) return done;
  return ok({ id: parsedId.data, retainData: parsed.data });
}

/**
 * Only a draft event with no participants can be deleted. Everything else is
 * kept for the audit trail. Uploaded import files and the logo are queued for
 * deletion with the rows and deleted after the commit; a failed delete stays
 * queued for the retention cron (D184).
 */
export async function deleteEvent(
  db: Db,
  id: unknown,
  actorId: string,
): Promise<ActionResult<{ id: string }>> {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return fail("not_found", "That event no longer exists.");
  // Lock the row while it is still a draft, then count, so a participant
  // added or a status change in between can't slip past the checks.
  const done = await inEventTransaction(db, parsedId.data, "draft", async (tx, event) => {
    const [{ value: participantCount }] = await tx
      .select({ value: count() })
      .from(participants)
      .where(eq(participants.eventId, event.id));
    if (participantCount > 0) return null;
    // The import rows go with the event (cascade); their stored files don't.
    const files = await tx.select({ key: imports.fileKey }).from(imports).where(eq(imports.eventId, event.id));
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
    const keys = [...files.map((f) => f.key), ...(event.branding?.logoKey ? [event.branding.logoKey] : [])];
    await queueFileDeletions(tx, keys);
    return keys;
  });
  if (!done.ok) return done;
  if (!done.data) {
    return fail("conflict", "This event already has participants, so it can't be deleted. Archive it instead.");
  }
  await deleteQueuedFilesNow(db, done.data);
  return ok({ id: parsedId.data });
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

  const done = await inEventTransaction(db, event.id, "unarchived", async (tx) => {
    const changed = await tx
      .update(events)
      .set({ status: "archived" })
      .where(and(eq(events.id, event.id), eq(events.status, event.status)))
      .returning({ id: events.id });
    if (changed.length === 0) throw new EventChangedError();
    // Under the row lock the update took: a send mid-flight must finish first.
    if (await hasSendInProgress(tx, event.id)) throw new Refused(fail("conflict", SEND_IN_PROGRESS_MESSAGE));
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
