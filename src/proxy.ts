import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, createNonce } from "@/lib/csp";
import { clientAddress, SlidingWindowLimiter } from "@/lib/rate-limit";

const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password"];
const PUBLIC_PREFIXES = ["/invite/", "/s/", "/api/"];

/** Scope 2.1: 60 participant-page requests per IP per 10 minutes, per instance. */
const participantLimiter = new SlidingWindowLimiter(60, 10 * 60 * 1000);

const TOO_MANY_REQUESTS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Too many requests</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.25rem">Too many requests</h1>
<p>This schedule link was opened too many times in a short while. Wait a few minutes, then try again.</p>
</body></html>`;

function isPublic(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * Runs before every page and route:
 * 1. Participant links (`/s/*`) are rate limited per IP.
 * 2. Every response gets a nonce-based Content-Security-Policy; Next.js reads
 *    the nonce from the request header and puts it on its own scripts.
 * 3. Optimistic auth: no session cookie sends you to /login. Pages still
 *    verify the session against the database.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/s/")) {
    const limited = participantLimiter.hit(clientAddress(request.headers));
    if (!limited.allowed) {
      return new NextResponse(TOO_MANY_REQUESTS_HTML, {
        status: 429,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": String(limited.retryAfterSeconds),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
  }

  const nonce = createNonce();
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });

  if (!isPublic(pathname) && !getSessionCookie(request)) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
    const redirect = NextResponse.redirect(loginUrl);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$).*)",
  ],
};
