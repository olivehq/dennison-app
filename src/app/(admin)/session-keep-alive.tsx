"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";

/**
 * Counts moving around the admin pages as activity for the 12-hour session
 * (scope 2.1). The auth route can set cookies, unlike a page render, so it
 * refreshes the session and the cookie together (at most once an hour).
 */
export function SessionKeepAlive() {
  const pathname = usePathname();
  React.useEffect(() => {
    void authClient.getSession().catch(() => undefined);
  }, [pathname]);
  return null;
}
