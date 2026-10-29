"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";

/** Share one throttle across navigation, visibility changes, and the interval. */
export function createSessionRefresh(
  refresh: () => Promise<unknown>,
  isVisible: () => boolean,
  now: () => number = Date.now,
) {
  let lastAttempt: number | null = null;
  return () => {
    const time = now();
    if (!isVisible() || (lastAttempt !== null && time - lastAttempt < 5 * 60 * 1000)) return;
    lastAttempt = time;
    void refresh().catch(() => undefined);
  };
}

/** Refresh visible admin tabs, including long edits on a single page. */
export function SessionKeepAlive() {
  const pathname = usePathname();
  const [refresh] = React.useState(() => createSessionRefresh(
    () => authClient.getSession(),
    () => document.visibilityState === "visible",
  ));
  React.useEffect(() => {
    refresh();
  }, [pathname, refresh]);
  React.useEffect(() => {
    // Better Auth refreshes at most once an hour; sessions expire after 12 hours.
    const interval = window.setInterval(refresh, 15 * 60 * 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);
  return null;
}
