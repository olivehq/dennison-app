import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned, isPasswordCompromised, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { accounts, admins, rateLimits, sessions, twoFactors, verifications } from "@/db/schema";
import { sendEmail } from "@/lib/email/adapter";
import { env } from "@/lib/env";
import { BREACHED_PASSWORD_MESSAGE } from "@/lib/schemas/auth";
import { recordAudit } from "@/server/audit/audit";
import { acceptInvite, findPendingInviteByToken } from "./admins";

const ONE_HOUR = 60 * 60;
const TEN_MINUTES = 60 * 10;
const TWELVE_HOURS = 12 * ONE_HOUR;
const STRICT_RATE_LIMIT = { window: TEN_MINUTES, max: 5 };

export const APP_NAME = "AW appointment matching";

/** The Better Auth routes that can turn two-factor sign-in on or off. */
const TWO_FACTOR_TOGGLE_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/enable", "/two-factor/disable"]);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export type CreateAuthOptions = {
  /**
   * Check new passwords against Have I Been Pwned's range API. On by default
   * outside tests, so the test suite never reaches the network; a test that
   * turns it on stubs `fetch`.
   */
  checkBreachedPasswords?: boolean;
};

/**
 * Builds a Better Auth instance bound to one database handle. Tests call this
 * with a PGlite db; the app uses the `getAuth()` singleton.
 */
export function createAuth(db: Db, options: CreateAuthOptions = {}) {
  const checkBreachedPasswords = options.checkBreachedPasswords ?? env.isProduction;
  return betterAuth({
    appName: APP_NAME,
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: admins,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: rateLimits,
        twoFactor: twoFactors,
      },
    }),
    // Names change only through the audited profile action (updateProfileName).
    disabledPaths: ["/update-user"],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: ONE_HOUR,
      sendResetPassword: async ({ user, url }) => {
        // A disabled admin can't sign in, so the link would be useless. The
        // form shows the same "Check your inbox" either way.
        const [row] = await db.select({ disabledAt: admins.disabledAt }).from(admins).where(eq(admins.id, user.id));
        if (!row || row.disabledAt) return;
        const name = escapeHtml(user.name);
        await sendEmail({
          to: user.email,
          from: env.EMAIL_FROM,
          subject: `Reset your ${APP_NAME} password`,
          html: `<p>Hi ${name},</p><p>Someone asked to reset the password for this account. The link works for one hour.</p><p><a href="${url}">Reset password</a></p><p>If that wasn't you, ignore this email and your password stays the same.</p>`,
          text: `Hi ${user.name},\n\nSomeone asked to reset the password for this account. The link works for one hour.\n\n${url}\n\nIf that wasn't you, ignore this email and your password stays the same.`,
          tags: { kind: "password_reset" },
        });
      },
    },
    session: {
      expiresIn: TWELVE_HOURS,
      updateAge: ONE_HOUR,
    },
    user: {
      additionalFields: {
        disabledAt: { type: "date", required: false, input: false },
        invitedBy: { type: "string", required: false, input: false },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": STRICT_RATE_LIMIT,
        "/sign-up/email": STRICT_RATE_LIMIT,
        "/request-password-reset": STRICT_RATE_LIMIT,
        "/change-password": STRICT_RATE_LIMIT,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // "Trust this device" would let a cookie skip the code step for 30
        // days. The app never offers it, and a direct call can't ask for it.
        if (ctx.path.startsWith("/two-factor/verify") && (ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice) {
          throw new APIError("BAD_REQUEST", { message: "This app doesn't remember devices. Enter a code each time." });
        }
        // The reset route uses up its link before it hashes the new password,
        // so the breach check for resets runs only here, once, before that:
        // a breached password, or a breach service that is down, leaves the
        // link usable. The plugin below checks sign-up and change password.
        if (!checkBreachedPasswords || ctx.path !== "/reset-password") return;
        const body = ctx.body as { token?: unknown; newPassword?: unknown } | undefined;
        // Same precedence as Better Auth's route: the body token, else `?token=`.
        const token = body?.token || (ctx.query as { token?: unknown } | undefined)?.token;
        if (typeof token !== "string" || typeof body?.newPassword !== "string") return;
        if (!(await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`))) return;
        if (await isPasswordCompromised(body.newPassword)) {
          throw new APIError("BAD_REQUEST", { message: BREACHED_PASSWORD_MESSAGE, code: "PASSWORD_COMPROMISED" });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // No self-signup: the sign-up request body must carry `inviteToken`,
          // the token of a pending, unexpired invite for this email. It is read
          // from the request, not declared as a user field, so it is never
          // stored. A user created outside a request (no context) is refused.
          before: async (user, context) => {
            const email = user.email.toLowerCase();
            const token = (context?.body as { inviteToken?: unknown } | undefined)?.inviteToken;
            const invite =
              typeof token === "string" && token.length > 0
                ? await findPendingInviteByToken(db, email, token)
                : null;
            if (!invite) {
              throw new APIError("FORBIDDEN", {
                message: "Sign up needs a valid invitation link. Ask a colleague to invite you.",
              });
            }
            return { data: { ...user, email, invitedBy: invite.invitedBy } };
          },
          // The before hook's read is not locked, so an invite revoked (or
          // expired) after it could still be accepted. Accepting is a
          // compare-and-set: it only takes an invite that is still pending
          // and unexpired, waiting on a revoke that holds the row. If it
          // fails, the user just created is deleted and sign-up fails. Better
          // Auth runs this right after inserting the user, before it links the
          // password or starts a session (transactions are off in the adapter).
          after: async (user, context) => {
            const email = user.email.toLowerCase();
            const token = (context?.body as { inviteToken?: unknown } | undefined)?.inviteToken;
            const accepted = typeof token === "string" && (await acceptInvite(db, { email, token, user }));
            if (!accepted) {
              await db.delete(admins).where(eq(admins.id, user.id));
              throw new APIError("FORBIDDEN", {
                message: "This invitation was revoked or expired while you were signing up. Ask a colleague to send a new one.",
              });
            }
          },
        },
        update: {
          // Turning two-factor sign-in on or off writes `twoFactorEnabled`
          // through Better Auth's routes, whether the browser or a server call
          // made the request, so the audit row is written here. The session
          // the route checked still holds the value from before the change.
          after: async (user, context) => {
            const enabled = (user as { twoFactorEnabled?: unknown }).twoFactorEnabled;
            if (typeof enabled !== "boolean" || !context || !TWO_FACTOR_TOGGLE_PATHS.has(context.path)) return;
            const sessionUser = context.context.session?.user as { twoFactorEnabled?: boolean | null } | undefined;
            if ((sessionUser?.twoFactorEnabled ?? false) === enabled) return;
            await recordAudit(db, {
              eventId: null,
              adminId: user.id,
              action: enabled ? "admin.two_factor_enable" : "admin.two_factor_disable",
              entityType: "admin",
              entityId: user.id,
            });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [user] = await db
              .select({ disabledAt: admins.disabledAt })
              .from(admins)
              .where(eq(admins.id, session.userId));
            if (user?.disabledAt) {
              throw new APIError("FORBIDDEN", {
                message: "This account has been disabled. Ask a colleague to re-enable it.",
              });
            }
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: APP_NAME,
        // The sign-in step takes 6-digit codes from an authenticator app or a
        // backup code. The app offers no email codes and no "trust this device".
        totpOptions: { digits: 6, period: 30 },
      }),
      haveIBeenPwned({
        enabled: checkBreachedPasswords,
        // Resets are checked in the before hook above, once, before the link is used.
        paths: ["/sign-up/email", "/change-password"],
        customPasswordCompromisedMessage: BREACHED_PASSWORD_MESSAGE,
      }),
      // Must stay last: it copies Set-Cookie from Server Action calls.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: { db: Db; auth: Auth } | undefined;

/** The app-wide instance, rebuilt only when `getDb()` hands back a different handle (tests). */
export function getAuth(): Auth {
  const db = getDb();
  if (!cached || cached.db !== db) {
    cached = { db, auth: createAuth(db) };
  }
  return cached.auth;
}
