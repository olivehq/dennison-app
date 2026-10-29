import { safeNextPath } from "@/app/(auth)/auth-errors";

/**
 * The proxy copies each request's path and query into this request header, so
 * `requireSession` can send an expired or disabled session back to the same
 * page after sign-in. The proxy overwrites any value the client sent.
 */
export const NEXT_PATH_HEADER = "x-next-path";

/** `/login`, with `next` set to the request's path when it is a safe one other than the default. */
export function loginPathFor(requestPath: string | null, sessionEnded = false): string {
  const next = safeNextPath(requestPath ?? undefined, "");
  const params = new URLSearchParams();
  if (next !== "" && next !== "/") params.set("next", next);
  if (sessionEnded) params.set("sessionEnded", "1");
  return params.size ? `/login?${params}` : "/login";
}
