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

/**
 * Bearer secrets that travel in URLs: participant links (`/s/<token>`, D14),
 * admin invites (`/invite/<token>`), and password reset links (Better Auth's
 * `/reset-password/<token>` and the `?token=` it redirects with).
 */
const TOKEN_PATHS: [RegExp, string][] = [
  [/\/s\/[A-Za-z0-9_-]+/g, "/s/[token]"],
  [/\/invite\/[A-Za-z0-9_-]+/g, "/invite/[token]"],
  [/\/reset-password\/[A-Za-z0-9_-]+/g, "/reset-password/[token]"],
];
/** `token=`, `inviteToken=`, `access_token=` and the like in a query string, encoded or not. */
const TOKEN_PARAM = /((?:^|[?&;\s]|%3F|%26)[\w-]*token(?:=|%3D))[^&#\s"']+/gi;
/** Query-string keys whose value is a secret. */
const TOKEN_KEY = /token$/i;

export function scrubTokens<T>(value: T): T {
  if (typeof value !== "string") return value;
  let out: string = value;
  for (const [pattern, replacement] of TOKEN_PATHS) out = out.replace(pattern, replacement);
  return out.replace(TOKEN_PARAM, "$1[token]") as T;
}

/** Scrubs every string inside a value: objects and arrays are walked, other values are kept. */
function scrubDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubTokens(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) record[key] = scrubDeep(record[key], depth + 1);
  return value;
}

/** Sentry's query string is a string, an object, or a list of pairs. Values under a `*token` key go entirely. */
function scrubQuery<T>(query: T): T {
  if (Array.isArray(query)) {
    return query.map((pair) =>
      Array.isArray(pair) && typeof pair[0] === "string" && TOKEN_KEY.test(pair[0]) ? [pair[0], "[token]"] : scrubDeep(pair),
    ) as T;
  }
  if (query && typeof query === "object") {
    const record = query as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = TOKEN_KEY.test(key) ? "[token]" : scrubDeep(record[key]);
    }
    return query;
  }
  return scrubTokens(query);
}

/**
 * `beforeSend` for every Sentry.init: strips tokens from the request URL,
 * query string, and referer, the transaction, exception and log messages,
 * contexts (such as Next.js's `request_path`), tags, extra, and breadcrumbs.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    if (event.request.url) event.request.url = scrubTokens(event.request.url);
    if (event.request.query_string) event.request.query_string = scrubQuery(event.request.query_string);
    if (event.request.headers) scrubDeep(event.request.headers);
  }
  if (event.transaction) event.transaction = scrubTokens(event.transaction);
  if (event.message) event.message = scrubTokens(event.message);
  if (event.logentry) scrubDeep(event.logentry);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubTokens(exception.value);
  }
  if (event.contexts) scrubDeep(event.contexts);
  if (event.tags) scrubDeep(event.tags);
  if (event.extra) scrubDeep(event.extra);
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubTokens(crumb.message);
    if (crumb.data) scrubDeep(crumb.data);
  }
  return event;
}
