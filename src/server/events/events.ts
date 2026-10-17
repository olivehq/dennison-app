import { and, count, eq, max, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { appointments, events, imports, matchRuns, participants, type Event } from "@/db/schema";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { eventSchema, type EventInput } from "@/lib/schemas/event";
import { defaultEventSettings, eventSettingsSchema, type EventSettings } from "@/lib/schemas/event-settings";
import { deleteFile } from "@/lib/storage";
import { recordAudit } from "@/server/audit/audit";
import { assertEventEditable, EventChangedError, eventChangedResult, READ_ONLY_STATUSES } from "./editable";
import { advanceStatus, hasSendInProgress, SEND_IN_PROGRESS_MESSAGE } from "./status";

const idSchema = z.uuid();

/** Matches the event only while it is still editable: the compare half of a compare-and-set. */
function editableEvent(id: string) {
  return and(eq(events.id, id), notInArray(events.status, [...READ_ONLY_STATUSES]));
}

/** Thrown inside a transaction to roll it back and return `result`. */
class Refused extends Error {
  constructor(readonly result: ActionResult<never>) {
    super(result.ok ? "" : result.error.message);
  }
}

/** Runs `work` in a transaction, turning `EventChangedError` into the conflict result and `Refused` into its result. */
async function inTransaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await db.transaction(work));
  } catch (error) {
    if (error instanceof Refused) return error.result;
    const changed = eventChangedResult(error);
    if (changed) return changed;
    throw error;
  }
}

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

/** Writes the event's name, date, and timezone with a compare-and-set on its editable status. */
async function writeDetails(tx: Db, event: Event, details: EventInput, actorId: string): Promise<void> {
  const changed = await tx.update(events).set(details).where(editableEvent(event.id)).returning({ id: events.id });
  if (changed.length === 0) throw new EventChangedError();
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
 * the new settings. Earlier runs stay in the list.
 */
async function writeSettings(
  tx: Db,
  event: Event,
  submitted: Partial<EventSettings>,
  actorId: string,
  clearSchedule: boolean,
): Promise<{ clearedRunId: string | null }> {
  // Lock the row while it is still editable and merge into what is stored now,
  // so a concurrent setRetainData is kept.
  const [current] = await tx.select({ settings: events.settings }).from(events).where(editableEvent(event.id)).for("update");
  if (!current) throw new EventChangedError();
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
  const settings: EventSettings = { ...current.settings, ...submitted };
  await tx.update(events).set({ settings }).where(eq(events.id, event.id));
  await recordAudit(tx, {
    eventId: event.id,
    adminId: actorId,
    action: "event.settings",
    entityType: "event",
    entityId: event.id,
    before: current.settings,
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
  const loaded = await loadEvent(db, id);
  if (!loaded.ok) return loaded;
  const event = loaded.data;
  const blocked = assertEventEditable(event);
  if (blocked) return blocked;

  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const done = await inTransaction(db, (tx) => writeDetails(tx, event, parsed.data, actorId));
  if (!done.ok) return done;
  return ok({ id: event.id });
}

export async function updateEventSettings(
  db: Db,
  id: unknown,
  input: unknown,
  actorId: string,
  options: { clearSchedule?: boolean } = {},
): Promise<ActionResult<{ id: string; clearedRunId: string | null }>> {
  const loaded = await loadEvent(db, id);
  if (!loaded.ok) return loaded;
  const event = loaded.data;
  const blocked = assertEventEditable(event);
  if (blocked) return blocked;

  const parsed = eventSettingsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const done = await inTransaction(db, (tx) =>
    writeSettings(tx, event, withoutRetainData(parsed.data), actorId, options.clearSchedule ?? false),
  );
  if (!done.ok) return done;
  return ok({ id: event.id, clearedRunId: done.data.clearedRunId });
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
  const loaded = await loadEvent(db, id);
  if (!loaded.ok) return loaded;
  const event = loaded.data;
  const blocked = assertEventEditable(event);
  if (blocked) return blocked;
  if (input.details === undefined && input.settings === undefined) {
    return fail("validation", "Nothing to save. Change a value first.");
  }

  const details = input.details === undefined ? null : eventSchema.safeParse(input.details);
  const settings = input.settings === undefined ? null : eventSettingsSchema.safeParse(input.settings);
  const fieldErrors: Record<string, string[]> = {};
  if (details && !details.success) Object.assign(fieldErrors, fieldErrorsOf(fromZod(details.error), ""));
  if (settings && !settings.success) Object.assign(fieldErrors, fieldErrorsOf(fromZod(settings.error), "settings."));
  if (Object.keys(fieldErrors).length > 0) return fail("validation", "Check the highlighted fields.", fieldErrors);

  const done = await inTransaction(db, async (tx) => {
    const saved = settings?.success
      ? await writeSettings(tx, event, withoutRetainData(settings.data), actorId, input.clearSchedule ?? false)
      : { clearedRunId: null };
    if (details?.success) await writeDetails(tx, event, details.data, actorId);
    return saved;
  });
  if (!done.ok) {
    const errors = fieldErrorsOf(done, "settings.");
    return errors ? fail(done.error.code, done.error.message, errors) : done;
  }
  return ok({ id: event.id, clearedRunId: done.data.clearedRunId });
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
    // The only writer of retainData: lock the row and change that one key of
    // the stored settings, so a concurrent settings save is kept.
    const [row] = await tx
      .select({ settings: events.settings })
      .from(events)
      .where(and(eq(events.id, event.id), ne(events.status, "archived")))
      .for("update");
    if (!row) throw new EventChangedError();
    const stored = row.settings.retainData ?? false;
    if (stored === parsed.data) return;
    await tx.update(events).set({ settings: { ...row.settings, retainData: parsed.data } }).where(eq(events.id, event.id));
    await recordAudit(tx, {
      eventId: event.id,
      adminId: actorId,
      action: "event.retention",
      entityType: "event",
      entityId: event.id,
      before: { retainData: stored },
      after: { retainData: parsed.data },
    });
  });
  if (!done.ok) return done;
  return ok({ id: event.id, retainData: parsed.data });
}

/**
 * Only a draft event with no participants can be deleted. Everything else is
 * kept for the audit trail. Uploaded import files are deleted from storage
 * after the rows commit; `fileErrors` lists the keys that could not be, to
 * retry by hand (as the retention job does).
 */
export async function deleteEvent(
  db: Db,
  id: unknown,
  actorId: string,
): Promise<ActionResult<{ id: string; fileErrors: string[] }>> {
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
    return files.map((f) => f.key);
  });
  if (!done.ok) return done;
  if (!done.data) {
    return fail("conflict", "This event already has participants. Withdraw or remove them before deleting it.");
  }
  const fileErrors: string[] = [];
  for (const key of done.data) {
    try {
      await deleteFile(key);
    } catch {
      fileErrors.push(key);
    }
  }
  return ok({ id: event.id, fileErrors });
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
