"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fromZod, type ActionResult } from "@/lib/errors";
import {
  addAppointmentInput,
  lockScheduleInput,
  removeAppointmentInput,
  replaceAppointmentInput,
  swapCandidatesInput,
  undoAuditInput,
  unlockScheduleInput,
} from "@/lib/schemas/schedule";
import { requireAdmin } from "@/server/auth/session";
import {
  addAppointment,
  removeAppointment,
  replaceAppointment,
  swapCandidates,
  undoAudit,
  type EditResult,
  type SwapCandidate,
} from "./edits";
import { lockSchedule, reassignDesks, unlockSchedule, type DeskAssignment, type LockResult } from "./lock";

const uuid = z.uuid();

function revalidateSchedule(eventId: string) {
  revalidatePath(`/events/${eventId}/schedule`);
  revalidatePath(`/events/${eventId}/activity`);
  revalidatePath(`/events/${eventId}`);
}

function revalidateEvent(eventId: string) {
  revalidatePath(`/events/${eventId}`, "layout");
}

export async function replaceAppointmentAction(input: unknown): Promise<ActionResult<EditResult>> {
  const admin = await requireAdmin();
  const parsed = replaceAppointmentInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await replaceAppointment(getDb(), parsed.data, admin.id);
  if (result.ok) revalidateSchedule(result.data.eventId);
  return result;
}

export async function addAppointmentAction(input: unknown): Promise<ActionResult<EditResult>> {
  const admin = await requireAdmin();
  const parsed = addAppointmentInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await addAppointment(getDb(), parsed.data, admin.id);
  if (result.ok) revalidateSchedule(result.data.eventId);
  return result;
}

export async function removeAppointmentAction(input: unknown): Promise<ActionResult<EditResult>> {
  const admin = await requireAdmin();
  const parsed = removeAppointmentInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await removeAppointment(getDb(), parsed.data, admin.id);
  if (result.ok) revalidateSchedule(result.data.eventId);
  return result;
}

export async function undoAuditAction(input: unknown): Promise<ActionResult<EditResult>> {
  const admin = await requireAdmin();
  const parsed = undoAuditInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await undoAudit(getDb(), { ...parsed.data, adminId: admin.id });
  if (result.ok) revalidateSchedule(result.data.eventId);
  return result;
}

/** A read behind an action: the swap sheet asks for it with user input from a client component. */
export async function swapCandidatesAction(input: unknown): Promise<ActionResult<SwapCandidate[]>> {
  await requireAdmin();
  const parsed = swapCandidatesInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  return swapCandidates(getDb(), parsed.data);
}

export async function lockScheduleAction(input: unknown): Promise<ActionResult<LockResult>> {
  const admin = await requireAdmin();
  const parsed = lockScheduleInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await lockSchedule(getDb(), { eventId: parsed.data.eventId, adminId: admin.id });
  if (result.ok) revalidateEvent(parsed.data.eventId);
  return result;
}

export async function unlockScheduleAction(input: unknown): Promise<ActionResult<{ eventId: string }>> {
  const admin = await requireAdmin();
  const parsed = unlockScheduleInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await unlockSchedule(getDb(), { ...parsed.data, adminId: admin.id });
  if (result.ok) revalidateEvent(parsed.data.eventId);
  return result;
}

export async function reassignDesksAction(
  eventId: unknown,
): Promise<ActionResult<{ eventId: string; desks: DeskAssignment[] }>> {
  const admin = await requireAdmin();
  const parsed = uuid.safeParse(eventId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await reassignDesks(getDb(), { eventId: parsed.data, adminId: admin.id });
  if (result.ok) revalidateEvent(parsed.data);
  return result;
}
