import { headers } from "next/headers";
import { ThemeProvider } from "./theme-provider";
import { Toaster } from "@/components/ui/sonner";

/**
 * Light, dark, or system theme (D5) and toasts, for the admin and sign-in
 * layouts. Not in the root layout: next-themes renders an inline script, and on
 * pages that throw notFound() before streaming (the participant page, D144)
 * React then warns about a script tag. Participant pages are always light.
 */
export async function AppTheme({ children }: { children: React.ReactNode }) {
  // Set by src/proxy.ts, so the theme script passes the Content-Security-Policy.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange nonce={nonce}>
      {children}
      <Toaster />
    </ThemeProvider>
  );
}
