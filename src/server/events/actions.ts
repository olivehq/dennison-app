"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import type { ActionResult } from "@/lib/errors";
import { requireAdmin } from "@/server/auth/session";
import {
  archiveEvent as archiveEventRecord,
  createEvent as createEventRecord,
  deleteEvent as deleteEventRecord,
  updateEvent as updateEventRecord,
  setRetainData as setRetainDataRecord,
  updateEventSettings as updateEventSettingsRecord,
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

export async function updateEvent(id: unknown, input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireAdmin();
  const result = await updateEventRecord(getDb(), id, input, actor.id);
  if (result.ok) revalidateEvent(result.data.id);
  return result;
}

export async function updateEventSettings(id: unknown, settings: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireAdmin();
  const result = await updateEventSettingsRecord(getDb(), id, settings, actor.id);
  if (result.ok) revalidateEvent(result.data.id);
  return result;
}

export async function setRetainData(id: unknown, retain: unknown): Promise<ActionResult<{ id: string; retainData: boolean }>> {
  const actor = await requireAdmin();
  const result = await setRetainDataRecord(getDb(), id, retain, actor.id);
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
