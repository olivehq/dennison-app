"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fromZod, type ActionResult } from "@/lib/errors";
import { adminInviteSchema, changePasswordSchema, profileNameSchema } from "@/lib/schemas";
import {
  createInvite,
  disableAdminAccount,
  enableAdminAccount,
  type InviteSent,
  resendInvite as resendInviteRecord,
  revokeInvite as revokeInviteRecord,
} from "./admins";
import { getAuth } from "./auth";
import { changeAdminPassword, endOtherSessions, updateAdminName } from "./profile";
import { requireAdmin, requireSession } from "./session";

const TEAM_PATH = "/team";
const PROFILE_PATH = "/profile";

const idSchema = z.string().min(1);
const inviteIdSchema = z.uuid();

export async function inviteAdmin(input: unknown): Promise<ActionResult<InviteSent>> {
  const actor = await requireAdmin();
  const parsed = adminInviteSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await createInvite(getDb(), { ...parsed.data, invitedBy: actor.id });
  if (result.ok) revalidatePath(TEAM_PATH);
  return result;
}

export async function resendInvite(inviteId: unknown): Promise<ActionResult<InviteSent>> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(inviteId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await resendInviteRecord(getDb(), { inviteId: parsed.data, actorId: actor.id });
  if (result.ok) revalidatePath(TEAM_PATH);
  return result;
}

export async function revokeInvite(inviteId: unknown): Promise<ActionResult<{ inviteId: string }>> {
  const actor = await requireAdmin();
  const parsed = inviteIdSchema.safeParse(inviteId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await revokeInviteRecord(getDb(), { inviteId: parsed.data, actorId: actor.id });
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

/** Your own name. It shows in the sidebar on every admin page, so the whole admin layout refreshes. */
export async function updateProfileName(input: unknown): Promise<ActionResult<{ name: string }>> {
  const actor = await requireAdmin();
  const parsed = profileNameSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await updateAdminName(getDb(), { adminId: actor.id, name: parsed.data.name });
  if (result.ok) revalidatePath("/", "layout");
  return result;
}

/**
 * The form refreshes the page after a change. With "Sign out other sessions",
 * Better Auth replaces this browser's session and sets the new cookie, so the
 * refresh is a fresh request that carries it.
 */
export async function changePassword(input: unknown): Promise<ActionResult<{ otherSessionsSignedOut: boolean }>> {
  const actor = await requireAdmin();
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  return changeAdminPassword(getAuth(), getDb(), { adminId: actor.id, headers: await headers(), ...parsed.data });
}

/** Signs out one of your other sessions, or all of them when `sessionId` is left out. */
export async function signOutSessions(sessionId?: unknown): Promise<ActionResult<{ count: number }>> {
  const { user, session } = await requireSession();
  const parsed = idSchema.optional().safeParse(sessionId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await endOtherSessions(getDb(), {
    adminId: user.id,
    currentSessionId: session.id,
    sessionId: parsed.data,
  });
  revalidatePath(PROFILE_PATH);
  return result;
}
