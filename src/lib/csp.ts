/**
 * The Content-Security-Policy `src/proxy.ts` sends with every page, following
 * the Next.js nonce guide. Styles allow 'unsafe-inline' because Tailwind v4,
 * Radix, and sonner set inline style attributes; scripts need the nonce.
 */
export function buildCsp(input: { nonce: string; isDev: boolean; sentryDsn?: string }): string {
  const connect = ["'self'"];
  const sentryOrigin = originOf(input.sentryDsn);
  if (sentryOrigin) connect.push(sentryOrigin);
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    // React's dev overlay rebuilds server stacks with eval; production never needs it.
    ["script-src", "'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'", ...(input.isDev ? ["'unsafe-eval'"] : [])],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["connect-src", ...connect],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/** "https://key@o1.ingest.us.sentry.io/42" -> "https://o1.ingest.us.sentry.io". */
function originOf(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    return new URL(dsn).origin;
  } catch {
    return null;
  }
}

/** 16 random bytes, base64. Unpredictable and unique per request. */
export function createNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
