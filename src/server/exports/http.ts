import { z } from "zod";
import type { Event } from "@/db/schema";
import { getSession } from "@/server/auth/session";
import { getEvent } from "@/server/events/queries";
import { getActiveRun } from "@/server/matching/queries";
import { isEventEditable } from "@/server/events/editable";
import { getScheduleView, type ScheduleRun, type ScheduleView } from "@/server/schedule/views";
import { recordExport } from "./actions";
import { eventYear } from "./common";
import { EXPORT_CONTENT_TYPES, exportFilename, needsRun, type ExportKind } from "./kinds";
import { needsLock } from "./queries";

/**
 * Shared checks and responses for the export Route Handlers in
 * src/app/api/exports/[eventId]/. Errors are short plain-text bodies; the
 * page only links to exports that are available, so these are rare.
 */

export type ExportContext = {
  adminId: string;
  event: Event;
  year: string;
};

export function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const NO_SCHEDULE = "There is no active schedule yet. Run matching and activate a run first.";
const NOT_LOCKED = "Lock the schedule before downloading the participant access list.";

/** Session (401), then a well-formed event id (404). */
async function signedInAdmin(eventId: string): Promise<{ adminId: string } | Response> {
  const session = await getSession();
  if (!session) return plainResponse(401, "Sign in to download exports.");
  if (!z.uuid().safeParse(eventId).success) return plainResponse(404, "That event does not exist.");
  return { adminId: session.user.id };
}

/** Session (401), event (404), active run (409), and lock for the access list (409), in that order. Used by the access route; the GET exports go through `exportRoute`. */
export async function loadExportContext(
  eventId: string,
  kind: ExportKind,
): Promise<{ ok: true; context: ExportContext } | { ok: false; response: Response }> {
  const admin = await signedInAdmin(eventId);
  if (admin instanceof Response) return { ok: false, response: admin };
  const event = await getEvent(eventId);
  if (!event) return { ok: false, response: plainResponse(404, "That event does not exist.") };
  if (needsRun(kind) && !(await getActiveRun(event.id))) return { ok: false, response: plainResponse(409, NO_SCHEDULE) };
  if (needsLock(kind) && isEventEditable(event)) return { ok: false, response: plainResponse(409, NOT_LOCKED) };
  return { ok: true, context: { adminId: admin.adminId, event, year: eventYear(event.eventDate) } };
}

/** The exports a GET route serves: everything but the access list, which issues links on POST. */
type GetExportKind = Exclude<ExportKind, "access_list">;
type RunExportKind = "master" | "schedules" | "report";

/** The schedule view with an active run, as the builders of the run-based exports receive it. */
export type ActiveScheduleView = ScheduleView & { run: ScheduleRun };

/** What a builder hands back: the file, and extra facts for the audit row. */
export type ExportBuild = { body: BodyInit; details?: Record<string, unknown> };

/** Builds the file. Returning a `Response` refuses instead, such as a run without statistics; it is sent as is and nothing is audited. */
export type ExportBuilder<K extends GetExportKind> = (
  context: ExportContext,
  view: K extends RunExportKind ? ActiveScheduleView : null,
) => Promise<ExportBuild | Response>;

/**
 * One GET export from request to response. Checks the session (401), loads the
 * event and, for the run-based kinds, the schedule view once (404, 409), calls
 * `build`, writes the audit row with the run id and version of that same view,
 * and returns the download. The audit row goes before the response so a
 * streamed file cannot outrun it. Any failure is logged without names, emails,
 * or tokens and answered with a short 500.
 */
export async function exportRoute<K extends GetExportKind>(
  kind: K,
  params: Promise<{ eventId: string }>,
  build: ExportBuilder<K>,
): Promise<Response> {
  let eventId: string | undefined;
  try {
    ({ eventId } = await params);
    const admin = await signedInAdmin(eventId);
    if (admin instanceof Response) return admin;

    let event: Event | null;
    let view: ActiveScheduleView | null = null;
    if (needsRun(kind)) {
      const loaded = await getScheduleView(eventId);
      event = loaded?.event ?? null;
      if (loaded?.run) view = { ...loaded, run: loaded.run };
    } else {
      event = await getEvent(eventId);
    }
    if (!event) return plainResponse(404, "That event does not exist.");
    if (needsRun(kind) && !view) return plainResponse(409, NO_SCHEDULE);

    const context: ExportContext = { adminId: admin.adminId, event, year: eventYear(event.eventDate) };
    const built = await build(context, view as K extends RunExportKind ? ActiveScheduleView : null);
    if (built instanceof Response) return built;

    await recordExport({
      eventId: event.id,
      adminId: admin.adminId,
      kind,
      ...(view ? { runId: view.run.id, runVersion: view.run.version } : {}),
      details: built.details,
    });
    return fileResponse(built.body, kind, context.year);
  } catch (error) {
    // Error messages can quote SQL parameters and names, so log only the kind of error.
    const type = error instanceof Error ? error.name : typeof error;
    console.error(`[exports] ${kind} export of event ${eventId ?? "unknown"} failed (${type}).`);
    return plainResponse(500, "The export failed. Try again, and tell your administrator if it keeps happening.");
  }
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
