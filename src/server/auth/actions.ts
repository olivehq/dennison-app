"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fromZod, type ActionResult } from "@/lib/errors";
import { adminInviteSchema } from "@/lib/schemas";
import {
  createInvite,
  disableAdminAccount,
  enableAdminAccount,
  resendInvite as resendInviteRecord,
} from "./admins";
import { requireAdmin } from "./session";

export const TEAM_PATH = "/team";

const idSchema = z.string().min(1);

export async function inviteAdmin(input: unknown): Promise<ActionResult<{ inviteId: string }>> {
  const actor = await requireAdmin();
  const parsed = adminInviteSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await createInvite(getDb(), { ...parsed.data, invitedBy: actor.id });
  if (result.ok) revalidatePath(TEAM_PATH);
  return result;
}

export async function resendInvite(inviteId: unknown): Promise<ActionResult<{ inviteId: string }>> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(inviteId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await resendInviteRecord(getDb(), { inviteId: parsed.data, actorId: actor.id });
  if (result.ok) revalidatePath(TEAM_PATH);
  return result;
}

export async function disableAdmin(userId: unknown): Promise<ActionResult<{ userId: string }>> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(userId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await disableAdminAccount(getDb(), { userId: parsed.data, actorId: actor.id });
  if (result.ok) revalidatePath(TEAM_PATH);
  return result;
}

export async function enableAdmin(userId: unknown): Promise<ActionResult<{ userId: string }>> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(userId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await enableAdminAccount(getDb(), { userId: parsed.data, actorId: actor.id });
  if (result.ok) revalidatePath(TEAM_PATH);
  return result;
}
