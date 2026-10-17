import { safeNextPath } from "@/app/(auth)/auth-errors";

/**
 * The proxy copies each request's path and query into this request header, so
 * `requireSession` can send an expired or disabled session back to the same
 * page after sign-in. The proxy overwrites any value the client sent.
 */
export const NEXT_PATH_HEADER = "x-next-path";

/** `/login`, with `next` set to the request's path when it is a safe one other than the default. */
export function loginPathFor(requestPath: string | null): string {
  const next = safeNextPath(requestPath ?? undefined, "");
  if (next === "" || next === "/") return "/login";
  return `/login?${new URLSearchParams({ next })}`;
}
