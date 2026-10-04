"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fromZod, type ActionResult } from "@/lib/errors";
import { requireAdmin } from "@/server/auth/session";
import { getParticipant, getSupplier } from "./queries";
import { saveParticipantSchema, saveSupplierSchema } from "./schemas";
import {
  restoreParticipant,
  restoreSupplier,
  upsertParticipant,
  upsertSupplier,
  withdrawParticipant,
  withdrawSupplier,
  type SupplierStatusResult,
} from "./roster";

const idSchema = z.uuid();

type IdResult = ActionResult<{ id: string }>;

/** Every roster page lives under the event, so one layout revalidation covers them all. */
function revalidateEvent(eventId: string): void {
  revalidatePath(`/events/${eventId}`, "layout");
}

export async function saveParticipant(input: unknown): Promise<IdResult> {
  const actor = await requireAdmin();
  const parsed = saveParticipantSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { eventId, id, ...data } = parsed.data;
  const result = await upsertParticipant(getDb(), { eventId, id, data, adminId: actor.id });
  if (result.ok) revalidateEvent(eventId);
  return result;
}

async function participantAction(
  rawId: unknown,
  run: (input: { id: string; adminId: string }) => Promise<IdResult>,
): Promise<IdResult> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await run({ id: parsed.data, adminId: actor.id });
  if (result.ok) {
    const row = await getParticipant(parsed.data);
    if (row) revalidateEvent(row.eventId);
  }
  return result;
}

export async function withdrawParticipantAction(id: unknown): Promise<IdResult> {
  return participantAction(id, (input) => withdrawParticipant(getDb(), input));
}

export async function restoreParticipantAction(id: unknown): Promise<IdResult> {
  return participantAction(id, (input) => restoreParticipant(getDb(), input));
}

export async function saveSupplier(input: unknown): Promise<IdResult> {
  const actor = await requireAdmin();
  const parsed = saveSupplierSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const { eventId, id, ...data } = parsed.data;
  const result = await upsertSupplier(getDb(), { eventId, id, data, adminId: actor.id });
  if (result.ok) revalidateEvent(eventId);
  return result;
}

async function supplierAction<T extends { id: string }>(
  rawId: unknown,
  run: (input: { id: string; adminId: string }) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await run({ id: parsed.data, adminId: actor.id });
  if (result.ok) {
    const row = await getSupplier(parsed.data);
    if (row) revalidateEvent(row.eventId);
  }
  return result;
}

export async function withdrawSupplierAction(id: unknown): Promise<ActionResult<SupplierStatusResult>> {
  return supplierAction(id, (input) => withdrawSupplier(getDb(), input));
}

/** The result's `note` says when the supplier's old desk was taken and cleared. */
export async function restoreSupplierAction(id: unknown): Promise<ActionResult<SupplierStatusResult>> {
  return supplierAction(id, (input) => restoreSupplier(getDb(), input));
}
