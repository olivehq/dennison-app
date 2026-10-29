import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Next, Schibsted_Grotesk } from "next/font/google";
import { headers } from "next/headers";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const atkinson = Atkinson_Hyperlegible_Next({
  variable: "--font-atkinson",
  subsets: ["latin"],
  // Google has no metric overrides for this face yet, so skip the synthetic fallback.
  adjustFontFallback: false,
});

const schibsted = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AW appointment matching",
  description: "Appointment matching and schedules for the AW appointment show.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers makes every page render per request, which the
  // nonce-based CSP from src/proxy.ts needs (Next.js CSP guide).
  await headers();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${atkinson.variable} ${schibsted.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* The theme provider and toasts live in the admin and sign-in layouts (src/app/app-theme.tsx). */}
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
