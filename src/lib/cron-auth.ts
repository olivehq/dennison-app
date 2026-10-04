import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Returns the
 * response to send when the request is not allowed, or null when it is:
 * 503 when no secret is configured (the route stays shut), 401 otherwise.
 */
export function rejectCronRequest(authorization: string | null, secret: string | undefined): Response | null {
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not set, so cron routes are disabled." }, { status: 503 });
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  // Hash both sides so the comparison is constant time whatever the lengths.
  if (!authorization || !timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
