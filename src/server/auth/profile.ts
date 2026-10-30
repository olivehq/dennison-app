import { and, eq, ne, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import type { Db } from "@/db/client";
import { admins, rateLimits, sessions } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import {
  BREACH_CHECK_FAILED_PREFIX,
  BREACH_CHECK_UNAVAILABLE_MESSAGE,
  BREACHED_PASSWORD_MESSAGE,
  type ChangePasswordInput,
} from "@/lib/schemas/auth";
import { recordAudit } from "@/server/audit/audit";
import type { Auth } from "./auth";
import { describeUserAgent } from "./user-agent";

/**
 * Your own account: name, password, and sessions. Each function takes the
 * signed-in admin's id from the session (the action checks it first) and only
 * ever touches that admin's rows.
 */

export async function updateAdminName(
  db: Db,
  input: { adminId: string; name: string },
): Promise<ActionResult<{ name: string }>> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ name: admins.name, disabledAt: admins.disabledAt })
      .from(admins)
      .where(eq(admins.id, input.adminId))
      .for("update");
    if (!current) return fail("not_found", "Your account no longer exists. Sign in again.");
    if (current.disabledAt) return fail("unauthorized", "Your account is disabled. Contact an active admin.");
    if (current.name === input.name) return ok({ name: input.name });

    await tx.update(admins).set({ name: input.name, updatedAt: new Date() }).where(eq(admins.id, input.adminId));
    await recordAudit(tx, {
      eventId: null,
      adminId: input.adminId,
      action: "admin.profile_update",
      entityType: "admin",
      entityId: input.adminId,
      before: { name: current.name },
      after: { name: input.name },
    });
    return ok({ name: input.name });
  });
}

// Server-side Better Auth calls skip its HTTP limiter. Share counters across instances.
const PASSWORD_ATTEMPTS = { limit: 5, windowMs: 10 * 60 * 1000 };

async function consumePasswordAttempt(db: Db, adminId: string): Promise<number> {
  const key = `admin-password-change:${adminId}`;
  const now = Date.now();
  const expired = sql`${rateLimits.lastRequest} <= ${now - PASSWORD_ATTEMPTS.windowMs}`;
  // The unique key and conditional upsert serialize concurrent attempts, including first use.
  const [allowed] = await db.insert(rateLimits).values({
    id: key, key, count: 1, lastRequest: now,
  }).onConflictDoUpdate({
    target: rateLimits.key,
    set: {
      count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
      lastRequest: now,
    },
    setWhere: sql`${expired} or ${rateLimits.count} < ${PASSWORD_ATTEMPTS.limit}`,
  }).returning({ key: rateLimits.key });
  if (allowed) return 0;
  const [blocked] = await db.select().from(rateLimits).where(eq(rateLimits.key, key));
  return Math.max(1, Math.ceil((blocked.lastRequest + PASSWORD_ATTEMPTS.windowMs - now) / 1000));
}

const WRONG_CURRENT_PASSWORD =
  "That isn't your current password. Check it and try again. If you've forgotten it, sign out and use Forgot password.";

/**
 * Changes the signed-in admin's password through Better Auth, which checks the
 * current one. `headers` carries the session cookie. With
 * `revokeOtherSessions`, Better Auth ends every session and starts a fresh one
 * for this browser (the cookie is set by the nextCookies plugin).
 */
export async function changeAdminPassword(
  auth: Auth,
  db: Db,
  input: { adminId: string; headers: Headers } & Pick<
    ChangePasswordInput,
    "currentPassword" | "newPassword" | "revokeOtherSessions"
  >,
): Promise<ActionResult<{ otherSessionsSignedOut: boolean }>> {
  const [admin] = await db.select({ disabledAt: admins.disabledAt }).from(admins).where(eq(admins.id, input.adminId));
  if (!admin || admin.disabledAt) return fail("unauthorized", "Your account is unavailable. Sign in again or contact an active admin.");
  const retryAfterSeconds = await consumePasswordAttempt(db, input.adminId);
  if (retryAfterSeconds > 0) {
    const minutes = Math.ceil(retryAfterSeconds / 60);
    return fail(
      "rate_limited",
      `Too many tries. Wait ${minutes === 1 ? "a minute" : `${minutes} minutes`}, then try again.`,
    );
  }

  try {
    await auth.api.changePassword({
      headers: input.headers,
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: input.revokeOtherSessions,
      },
    });
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    switch ((error.body as { code?: string } | undefined)?.code) {
      case "INVALID_PASSWORD":
        return fail("validation", WRONG_CURRENT_PASSWORD, { currentPassword: [WRONG_CURRENT_PASSWORD] });
      case "PASSWORD_TOO_SHORT":
        return fail("validation", "Check the highlighted fields.", { newPassword: ["Use at least 10 characters."] });
      case "PASSWORD_TOO_LONG":
        return fail("validation", "Check the highlighted fields.", { newPassword: ["Use at most 128 characters."] });
      case "CREDENTIAL_ACCOUNT_NOT_FOUND":
        return fail("not_found", "This account has no password to change. Use Forgot password on the sign-in page to set one.");
      case "PASSWORD_COMPROMISED":
        return fail("validation", "Check the highlighted fields.", { newPassword: [BREACHED_PASSWORD_MESSAGE] });
      default:
        if (error.statusCode === 401) return fail("unauthorized", "Your session ended. Sign in again, then retry.");
        // The breach check could not reach its service (D189); that failure carries no code.
        if (error.statusCode === 500 && error.message.startsWith(BREACH_CHECK_FAILED_PREFIX)) {
          return fail("internal", BREACH_CHECK_UNAVAILABLE_MESSAGE);
        }
        throw error;
    }
  }

  await recordAudit(db, {
    eventId: null,
    adminId: input.adminId,
    action: "admin.password_change",
    entityType: "admin",
    entityId: input.adminId,
    after: { otherSessionsSignedOut: input.revokeOtherSessions },
  });
  return ok({ otherSessionsSignedOut: input.revokeOtherSessions });
}

/**
 * Ends one of your other sessions (`sessionId`), or all of them. The session
 * making the request is never touched. Deleting the rows signs those browsers
 * out on their next request, as disabling an admin does (D22).
 */
export async function endOtherSessions(
  db: Db,
  input: { adminId: string; currentSessionId: string; sessionId?: string },
): Promise<ActionResult<{ count: number }>> {
  if (input.sessionId === input.currentSessionId) {
    return fail("validation", "That's this browser. To sign out here, use Sign out in the menu.");
  }
  return db.transaction(async (tx) => {
    const [admin] = await tx.select({ disabledAt: admins.disabledAt }).from(admins).where(eq(admins.id, input.adminId)).for("update");
    if (!admin || admin.disabledAt) return fail("unauthorized", "Your account is unavailable. Sign in again or contact an active admin.");
    const ended = await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, input.adminId),
          ne(sessions.id, input.currentSessionId),
          input.sessionId ? eq(sessions.id, input.sessionId) : undefined,
        ),
      )
      .returning({ userAgent: sessions.userAgent });
    if (input.sessionId && ended.length === 0) {
      return fail("not_found", "That session already ended. The list is up to date now.");
    }
    if (ended.length > 0) {
      await recordAudit(tx, {
        eventId: null,
        adminId: input.adminId,
        action: "admin.sessions_sign_out",
        entityType: "admin",
        entityId: input.adminId,
        after: { count: ended.length, devices: ended.map((row) => describeUserAgent(row.userAgent)) },
      });
    }
    return ok({ count: ended.length });
  });
}
