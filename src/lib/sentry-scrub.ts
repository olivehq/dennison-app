import type { ErrorEvent, init } from "@sentry/nextjs";

type DataCollection = NonNullable<NonNullable<Parameters<typeof init>[0]>["dataCollection"]>;

/**
 * What every Sentry.init may collect: the stack and the URL path, nothing that
 * identifies a person or holds a secret. Sentry's defaults would send session
 * cookies, request headers, request bodies (passwords on sign-in), and query
 * strings (password reset tokens).
 */
export const SENTRY_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false,
};

/** Participant links are bearer tokens (D14): never send one to Sentry. */
const TOKEN_PATH = /\/s\/[A-Za-z0-9_-]+/g;

export function scrubTokens<T>(value: T): T {
  return (typeof value === "string" ? value.replace(TOKEN_PATH, "/s/[token]") : value) as T;
}

/** `beforeSend` for every Sentry.init: strips tokens from URLs, the transaction, and breadcrumbs. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request?.url) event.request.url = scrubTokens(event.request.url);
  if (event.request?.headers?.referer) event.request.headers.referer = scrubTokens(event.request.headers.referer);
  if (event.transaction) event.transaction = scrubTokens(event.transaction);
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubTokens(crumb.message);
    if (crumb.data) {
      for (const key of ["url", "from", "to"]) {
        if (typeof crumb.data[key] === "string") crumb.data[key] = scrubTokens(crumb.data[key]);
      }
    }
  }
  return event;
}
