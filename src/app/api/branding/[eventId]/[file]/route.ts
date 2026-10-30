import type { NextRequest } from "next/server";
import { loadCurrentLogo } from "@/server/events/branding";

/**
 * An event's current logo, for the participant page and the settings preview
 * (D181). Public: a logo holds no participant data, and the file name is a
 * random UUID that changes on every upload, so it is cached for a year.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/branding/[eventId]/[file]">) {
  const { eventId, file } = await ctx.params;
  const logo = await loadCurrentLogo(eventId, file);
  if (!logo) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(logo.body), {
    headers: {
      "Content-Type": logo.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // An SVG opened on its own runs no script and loads nothing.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
