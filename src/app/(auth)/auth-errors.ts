/** The error half of a Better Auth client result. */
export type AuthClientError = {
  code?: string;
  message?: string;
  status: number;
  statusText: string;
};

const RATE_LIMITED = "Too many attempts from this connection. Wait 10 minutes, then try again.";

/** Plain-words copy for the errors our auth forms can hit. Falls back to the server message, then `fallback`. */
export function describeAuthError(error: AuthClientError, fallback: string): string {
  if (error.status === 429) return RATE_LIMITED;
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
    case "USER_NOT_FOUND":
      return "That email and password don't match. Check both and try again.";
    case "INVALID_TOKEN":
      return "This link has expired or was already used. Request a new one.";
    case "PASSWORD_TOO_SHORT":
      return "Use at least 10 characters for the password.";
    case "PASSWORD_TOO_LONG":
      return "Use at most 128 characters for the password.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "An account with this email already exists. Sign in instead.";
    default:
      return error.message || fallback;
  }
}

/** A stand-in origin: `next` must resolve against it and stay on it. */
const SAME_SITE = "http://same-site.invalid";

/**
 * Only allow same-site paths as a post-login destination. A repeated `next`
 * (an array), backslashes, control characters (also percent-encoded), and
 * anything that resolves to another origin or a `//` path fall back.
 */
export function safeNextPath(next: string | string[] | undefined, fallback = "/events"): string {
  if (typeof next !== "string" || !next.startsWith("/")) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  let url: URL;
  try {
    url = new URL(next, SAME_SITE);
  } catch {
    return fallback;
  }
  if (url.origin !== SAME_SITE || url.pathname.startsWith("//")) return fallback;
  return url.pathname + url.search + url.hash;
}
