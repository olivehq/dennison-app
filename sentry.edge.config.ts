import * as Sentry from "@sentry/nextjs";
import { scrubEvent, SENTRY_DATA_COLLECTION } from "@/lib/sentry-scrub";

// Loaded by src/instrumentation.ts for the edge runtime. Without SENTRY_DSN (local dev, tests) nothing starts.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    // Errors only: the free tier is for alerts, not performance tracing.
    tracesSampleRate: 0,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: scrubEvent,
  });
}
