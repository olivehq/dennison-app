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

/** Only allow same-site paths as a post-login destination. */
export function safeNextPath(next: string | undefined, fallback = "/events"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}
