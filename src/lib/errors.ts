import type { ZodError } from "zod";

export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "validation"
  | "conflict"
  | "locked"
  | "rate_limited"
  | "internal";

export type ActionError = {
  code: ErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail<T = never>(
  code: ErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<T> {
  return { ok: false, error: fieldErrors ? { code, message, fieldErrors } : { code, message } };
}

/** Turns a zod error into a validation failure keyed by field path ("contacts.0.email"). */
export function fromZod<T = never>(error: ZodError): ActionResult<T> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fail("validation", "Check the highlighted fields.", fieldErrors);
}
