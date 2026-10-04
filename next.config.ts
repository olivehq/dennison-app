import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

/**
 * Security headers (scope 2.1). The Content-Security-Policy needs a fresh
 * nonce per request, so `src/proxy.ts` sets it; see docs/ARCHITECTURE.md.
 */
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** Participant links carry the token in the URL: never send it on, never index it (D44). */
const PARTICIPANT_HEADERS = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  // PGlite ships WASM assets that must load from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    serverActions: {
      // uploadImport accepts files up to 5 MB (IMPORT_MAX_FILE_BYTES); leave room for multipart overhead.
      bodySizeLimit: "6mb",
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Later entries win for the same key, so this overrides the Referrer-Policy above.
      { source: "/s/:path*", headers: PARTICIPANT_HEADERS },
    ];
  },
};

/**
 * Sentry build step. Source maps upload only when SENTRY_AUTH_TOKEN is set
 * (the Sentry Vercel integration sets it with SENTRY_ORG and SENTRY_PROJECT);
 * without it the build does nothing Sentry-specific beyond the SDK itself.
 */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  silent: !process.env.CI,
  telemetry: false,
});
