"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fromZod, type ActionResult } from "@/lib/errors";
import { runMatchingInput, setPinnedInput } from "@/lib/schemas/schedule";
import { requireAdmin } from "@/server/auth/session";
import { activateRun, findRun, setPinned, startRun, type StartRunResult } from "./runs";

const uuid = z.uuid();

function eventPath(eventId: string): string {
  return `/events/${eventId}`;
}

/** Runs the engine for an event. `keepExisting` pins the active run's appointments (D10). */
export async function runMatchingAction(
  eventId: unknown,
  options: unknown,
): Promise<ActionResult<StartRunResult>> {
  const admin = await requireAdmin();
  const parsedId = uuid.safeParse(eventId);
  if (!parsedId.success) return fromZod(parsedId.error);
  const parsed = runMatchingInput.safeParse(options ?? {});
  if (!parsed.success) return fromZod(parsed.error);
  const result = await startRun(getDb(), {
    eventId: parsedId.data,
    adminId: admin.id,
    keepExisting: parsed.data.keepExisting,
  });
  if (result.ok) revalidatePath(eventPath(parsedId.data), "layout");
  return result;
}

export async function activateRunAction(runId: unknown): Promise<ActionResult<{ runId: string }>> {
  const admin = await requireAdmin();
  const parsed = uuid.safeParse(runId);
  if (!parsed.success) return fromZod(parsed.error);
  const db = getDb();
  const result = await activateRun(db, { runId: parsed.data, adminId: admin.id });
  if (result.ok) {
    const run = await findRun(db, parsed.data);
    if (run) revalidatePath(eventPath(run.eventId), "layout");
  }
  return result;
}

export async function setPinnedAction(
  input: unknown,
): Promise<ActionResult<{ appointmentId: string; pinned: boolean; version: number }>> {
  const admin = await requireAdmin();
  const parsed = setPinnedInput.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await setPinned(getDb(), { ...parsed.data, adminId: admin.id });
  if (result.ok) revalidatePath("/events/[id]/schedule", "page");
  return result;
}
