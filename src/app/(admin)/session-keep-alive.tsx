"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";

/** Refresh visible admin tabs, including long edits on a single page. */
export function SessionKeepAlive() {
  const pathname = usePathname();
  React.useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void authClient.getSession().catch(() => undefined);
      }
    };
    refresh();
    // Better Auth refreshes at most once an hour; sessions expire after 12 hours.
    const interval = window.setInterval(refresh, 15 * 60 * 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pathname]);
  return null;
}
