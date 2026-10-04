import * as Sentry from "@sentry/nextjs";
import { scrubEvent, SENTRY_DATA_COLLECTION } from "@/lib/sentry-scrub";

// Browser errors (scope 2.1). Without NEXT_PUBLIC_SENTRY_DSN nothing starts.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: 0,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: scrubEvent,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
