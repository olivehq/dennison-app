import { and, eq, ne } from "drizzle-orm";
import { APIError } from "better-auth/api";
import type { Db } from "@/db/client";
import { admins, sessions } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { SlidingWindowLimiter } from "@/lib/rate-limit";
import type { ChangePasswordInput } from "@/lib/schemas/auth";
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
      .select({ name: admins.name })
      .from(admins)
      .where(eq(admins.id, input.adminId))
      .for("update");
    if (!current) return fail("not_found", "Your account no longer exists. Sign in again.");
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

/**
 * Server-side calls skip Better Auth's own rate limit (it runs on the HTTP
 * route only), so a stolen session could guess the current password here
 * without one. Five tries per admin per 10 minutes, the same as sign-in. Held
 * in memory per instance, like the participant-link limiter in src/proxy.ts.
 */
const PASSWORD_ATTEMPTS = { limit: 5, windowMs: 10 * 60 * 1000 };
let passwordAttempts = new SlidingWindowLimiter(PASSWORD_ATTEMPTS.limit, PASSWORD_ATTEMPTS.windowMs);

/** Starts the attempt counts over. For tests. */
export function resetPasswordAttemptsForTests(): void {
  passwordAttempts = new SlidingWindowLimiter(PASSWORD_ATTEMPTS.limit, PASSWORD_ATTEMPTS.windowMs);
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
  const limited = passwordAttempts.hit(input.adminId);
  if (!limited.allowed) {
    const minutes = Math.ceil(limited.retryAfterSeconds / 60);
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
      default:
        if (error.statusCode === 401) return fail("unauthorized", "Your session ended. Sign in again, then retry.");
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
