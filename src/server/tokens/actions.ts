"use server";

import { revalidatePath } from "next/cache";
import { ok, type ActionResult } from "@/lib/errors";
import { requireAdmin } from "@/server/auth/session";
import { getDb } from "@/db/client";
import { linkFor, regenerateToken, revokeToken } from "./tokens";

function revalidateRoster(eventId: string) {
  revalidatePath(`/events/${eventId}/participants`);
  revalidatePath(`/events/${eventId}/suppliers`);
}

/** Replaces a contact's link. Returns the new link once; it is never shown again. */
export async function regenerateTokenAction(
  tokenId: unknown,
): Promise<ActionResult<{ tokenId: string; link: string; expiresAt: Date }>> {
  const admin = await requireAdmin();
  const result = await regenerateToken(getDb(), tokenId, admin.id);
  if (!result.ok) return result;
  revalidateRoster(result.data.eventId);
  return ok({ tokenId: result.data.tokenId, link: linkFor(result.data.token), expiresAt: result.data.expiresAt });
}

export async function revokeTokenAction(tokenId: unknown): Promise<ActionResult<{ tokenId: string }>> {
  const admin = await requireAdmin();
  const result = await revokeToken(getDb(), tokenId, admin.id);
  if (!result.ok) return result;
  revalidateRoster(result.data.eventId);
  return ok({ tokenId: result.data.tokenId });
}
