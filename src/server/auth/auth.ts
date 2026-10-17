import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { accounts, admins, rateLimits, sessions, verifications } from "@/db/schema";
import { sendEmail } from "@/lib/email/adapter";
import { env } from "@/lib/env";
import { acceptInvite, findPendingInviteByToken } from "./admins";

const ONE_HOUR = 60 * 60;
const TEN_MINUTES = 60 * 10;
const TWELVE_HOURS = 12 * ONE_HOUR;
const STRICT_RATE_LIMIT = { window: TEN_MINUTES, max: 5 };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Builds a Better Auth instance bound to one database handle. Tests call this
 * with a PGlite db; the app uses the `getAuth()` singleton.
 */
export function createAuth(db: Db) {
  return betterAuth({
    appName: "AW Appointment Show",
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
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: ONE_HOUR,
      sendResetPassword: async ({ user, url }) => {
        const name = escapeHtml(user.name);
        await sendEmail({
          to: user.email,
          from: env.EMAIL_FROM,
          subject: "Reset your AW Appointment Show password",
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
      },
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
    plugins: [nextCookies()],
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
