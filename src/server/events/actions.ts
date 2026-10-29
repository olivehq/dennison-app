"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fail, fromZod, type ActionResult } from "@/lib/errors";
import { requireAdmin } from "@/server/auth/session";
import { saveBranding } from "./branding";
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

/**
 * Expects FormData with `primaryColor`, `accentColor`, an optional `logo`
 * file, and `removeLogo` ("true" to clear the current logo).
 */
export async function saveEventBranding(id: unknown, formData: FormData): Promise<ActionResult<{ id: string }>> {
  const actor = await requireAdmin();
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) return fail("not_found", "That event no longer exists.");
  const file = formData.get("logo");
  const logo = file instanceof File && file.size > 0 ? Buffer.from(await file.arrayBuffer()) : null;
  const result = await saveBranding(
    getDb(),
    parsedId.data,
    {
      colors: { primaryColor: formData.get("primaryColor") ?? "", accentColor: formData.get("accentColor") ?? "" },
      logo,
      removeLogo: formData.get("removeLogo") === "true",
    },
    actor.id,
  );
  if (result.ok) revalidateEvent(result.data.id);
  return result;
}

export async function deleteEvent(id: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireAdmin();
  const result = await deleteEventRecord(getDb(), id, actor.id);
  if (result.ok) revalidatePath(EVENTS_PATH);
  return result;
}

export async function archiveEventAction(id: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireAdmin();
  const result = await archiveEventRecord(getDb(), { eventId: id, adminId: actor.id });
  if (result.ok) revalidateEvent(result.data.id);
  return result;
}
