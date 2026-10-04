import { z } from "zod";
import type { Event, MatchRun } from "@/db/schema";
import { getSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import { getActiveRun } from "@/server/matching/queries";
import { isEventEditable } from "@/server/events/editable";
import { eventYear } from "./common";
import { EXPORT_CONTENT_TYPES, exportFilename, type ExportKind } from "./kinds";
import { needsLock } from "./queries";

/**
 * Shared checks and responses for the export Route Handlers in
 * src/app/api/exports/[eventId]/. Errors are short plain-text bodies; the
 * page only links to exports that are available, so these are rare.
 */

export type ExportContext = {
  adminId: string;
  event: Event;
  run: Pick<MatchRun, "id" | "version">;
  year: string;
};

export function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Session (401), event (404), active run (409), and lock for the access list (409), in that order. */
export async function loadExportContext(
  eventId: string,
  kind: ExportKind,
): Promise<{ ok: true; context: ExportContext } | { ok: false; response: Response }> {
  const session = await getSession();
  if (!session) return { ok: false, response: plainResponse(401, "Sign in to download exports.") };
  if (!z.uuid().safeParse(eventId).success) {
    return { ok: false, response: plainResponse(404, "That event does not exist.") };
  }
  const event = await getEvent(eventId);
  if (!event) return { ok: false, response: plainResponse(404, "That event does not exist.") };
  const run = await getActiveRun(event.id);
  if (!run) {
    return {
      ok: false,
      response: plainResponse(409, "There is no active schedule yet. Run matching and activate a run first."),
    };
  }
  if (needsLock(kind) && isEventEditable(event)) {
    return {
      ok: false,
      response: plainResponse(409, "Lock the schedule before downloading the participant access list."),
    };
  }
  return {
    ok: true,
    context: { adminId: session.user.id, event, run: { id: run.id, version: run.version }, year: eventYear(event.eventDate) },
  };
}

/** A download with the spec's file name. */
export function fileResponse(body: BodyInit, kind: ExportKind, year: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": EXPORT_CONTENT_TYPES[kind],
      "Content-Disposition": `attachment; filename="${exportFilename(kind, year)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Refuses a cross-site POST. Session cookies are SameSite=Lax, so a forged
 * form post arrives without a session anyway; this makes the refusal explicit.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
