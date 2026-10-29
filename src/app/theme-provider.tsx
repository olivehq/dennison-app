"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * next-themes, with its inline theme script marked as a data block when React
 * renders it in the browser. That script only matters in the server HTML, where
 * it sets the theme before first paint; rendered on the client (moving between
 * the sign-in and admin layouts, which each mount this provider) it never runs,
 * and React 19 warns about a script tag unless its type is a data block. The
 * script already has suppressHydrationWarning, so the differing type is fine.
 */
export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  const scriptProps = typeof window === "undefined" ? undefined : { type: "text/plain" };
  return <NextThemesProvider {...props} scriptProps={scriptProps} />;
}
