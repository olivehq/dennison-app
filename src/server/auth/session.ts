import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth, type Auth } from "./auth";
import { loginPathFor, NEXT_PATH_HEADER } from "./login-redirect";

export type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type SessionUser = SessionData["user"];

/**
 * The current admin session, or null. Disabled accounts count as signed out.
 * One lookup per render however many layouts, slots, and pages ask; a Server
 * Action looks it up fresh (React's cache keeps nothing outside a render).
 */
export const getSession = cache(async function getSession(): Promise<SessionData | null> {
  // Read headers before touching auth so a build-time prerender bails out to
  // dynamic rendering without initialising the database or secrets.
  const requestHeaders = await headers();
  // Sessions last 12 hours from the last refresh (auth.ts). Only a Server
  // Action can write the cookie; a page render that refreshed would extend the
  // database row but leave the browser cookie to expire. So renders don't
  // refresh, and SessionKeepAlive refreshes through the auth route instead.
  const canSetCookies = requestHeaders.has("next-action");
  const result = await getAuth().api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: !canSetCookies },
  });
  if (!result || result.user.disabledAt) return null;
  return result;
});

/** The current session, or a redirect to /login that comes back to this page and its filters. */
export async function requireSession(): Promise<SessionData> {
  const session = await getSession();
  if (!session) redirect(loginPathFor((await headers()).get(NEXT_PATH_HEADER)));
  return session;
}

export async function requireAdmin(): Promise<SessionUser> {
  const { user } = await requireSession();
  return user;
}
