"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fromZod, type ActionResult } from "@/lib/errors";
import { requireAdmin } from "@/server/auth/session";
import {
  archiveEvent as archiveEventRecord,
  createEvent as createEventRecord,
  deleteEvent as deleteEventRecord,
  saveEventForm,
  setRetainData as setRetainDataRecord,
} from "./events";

const EVENTS_PATH = "/events";

function revalidateEvent(id: string) {
  revalidatePath(EVENTS_PATH);
  revalidatePath(`${EVENTS_PATH}/${id}`, "layout");
}

export async function createEvent(input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireAdmin();
  const result = await createEventRecord(getDb(), input, actor.id);
  if (result.ok) revalidatePath(EVENTS_PATH);
  return result;
}

const saveEventFormInput = z.object({
  details: z.unknown().optional(),
  settings: z.unknown().optional(),
  clearSchedule: z.boolean().default(false),
});

/**
 * The settings page's save: event details and settings in one transaction.
 * `clearSchedule` confirms clearing the active schedule when the new slot
 * count is below a slot it uses (the first try returns `needs_schedule_reset`).
 */
export async function saveEventSettings(
  id: unknown,
  input: unknown,
): Promise<ActionResult<{ id: string; clearedRunId: string | null }>> {
  const actor = await requireAdmin();
  const parsed = saveEventFormInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await saveEventForm(getDb(), id, parsed.data, actor.id);
  if (result.ok) revalidateEvent(result.data.id);
  return result;
}

export async function setRetainData(id: unknown, retain: unknown): Promise<ActionResult<{ id: string; retainData: boolean }>> {
  const actor = await requireAdmin();
  const result = await setRetainDataRecord(getDb(), id, retain, actor.id);
  if (result.ok) revalidateEvent(result.data.id);
  return result;
}

export async function deleteEvent(id: unknown): Promise<ActionResult<{ id: string; fileErrors: string[] }>> {
  const actor = await requireAdmin();
  const result = await deleteEventRecord(getDb(), id, actor.id);
  if (result.ok) {
    if (result.data.fileErrors.length > 0) {
      // Storage keys only, no names: enough to delete the files by hand.
      console.error(`[events] event ${result.data.id} deleted, but these files were not: ${result.data.fileErrors.join(", ")}`);
    }
    revalidatePath(EVENTS_PATH);
  }
  return result;
}

export async function archiveEventAction(id: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireAdmin();
  const result = await archiveEventRecord(getDb(), { eventId: id, adminId: actor.id });
  if (result.ok) revalidateEvent(result.data.id);
  return result;
}
