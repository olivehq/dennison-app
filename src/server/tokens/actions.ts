"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { accessTokens } from "@/db/schema";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit";
import { requireAdmin } from "@/server/auth/session";
import { linkFor, regenerateToken, revokeToken } from "./tokens";

const uuid = z.uuid();

async function tokenEvent(db: Db, tokenId: string) {
  const [row] = await db
    .select({ eventId: accessTokens.eventId, contactType: accessTokens.contactType, entityId: accessTokens.entityId })
    .from(accessTokens)
    .where(eq(accessTokens.id, tokenId))
    .limit(1);
  return row ?? null;
}

function revalidateRoster(eventId: string) {
  revalidatePath(`/events/${eventId}/participants`);
  revalidatePath(`/events/${eventId}/suppliers`);
}

/** Replaces a contact's link. Returns the new link once; it is never shown again. */
export async function regenerateTokenAction(
  tokenId: unknown,
): Promise<ActionResult<{ tokenId: string; link: string; expiresAt: Date }>> {
  const admin = await requireAdmin();
  const parsed = uuid.safeParse(tokenId);
  if (!parsed.success) return fromZod(parsed.error);
  const db = getDb();
  const before = await tokenEvent(db, parsed.data);
  if (!before) return fail("not_found", "That link no longer exists.");

  const result = await regenerateToken(db, parsed.data);
  if (!result.ok) return result;
  await recordAudit(db, {
    eventId: before.eventId,
    adminId: admin.id,
    action: "token.regenerate",
    entityType: "access_token",
    entityId: result.data.tokenId,
    before: { tokenId: result.data.previousTokenId },
    after: { contactType: before.contactType, entityId: before.entityId, expiresAt: result.data.expiresAt },
  });
  revalidateRoster(before.eventId);
  return ok({ tokenId: result.data.tokenId, link: linkFor(result.data.token), expiresAt: result.data.expiresAt });
}

export async function revokeTokenAction(tokenId: unknown): Promise<ActionResult<{ tokenId: string }>> {
  const admin = await requireAdmin();
  const parsed = uuid.safeParse(tokenId);
  if (!parsed.success) return fromZod(parsed.error);
  const db = getDb();
  const before = await tokenEvent(db, parsed.data);
  if (!before) return fail("not_found", "That link no longer exists.");

  const result = await revokeToken(db, parsed.data);
  if (!result.ok) return result;
  await recordAudit(db, {
    eventId: before.eventId,
    adminId: admin.id,
    action: "token.revoke",
    entityType: "access_token",
    entityId: result.data.tokenId,
    after: { contactType: before.contactType, entityId: before.entityId },
  });
  revalidateRoster(before.eventId);
  return result;
}
