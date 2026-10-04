"use client";

import * as Sentry from "@sentry/nextjs";
import * as React from "react";
import "./globals.css";

/** Replaces the root layout when it fails, so it brings its own html and body. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  React.useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center p-4 font-sans">
        <main className="flex max-w-md flex-col gap-3">
          <h1 className="text-xl font-bold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            Nothing was saved. Reload the page, and if it keeps failing tell Olive and quote this code:{" "}
            <span className="font-medium">{error.digest ?? "no code"}</span>.
          </p>
        </main>
      </body>
    </html>
  );
}
