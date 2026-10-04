import { recordExport } from "@/server/exports/actions";
import { fileResponse, loadExportContext, plainResponse } from "@/server/exports/http";
import { schedulesZip, toWebStream } from "@/server/exports/schedules";
import { getScheduleView } from "@/server/schedule/views";

export async function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/schedules">) {
  const { eventId } = await ctx.params;
  const loaded = await loadExportContext(eventId, "schedules");
  if (!loaded.ok) return loaded.response;
  const { context } = loaded;
  const view = await getScheduleView(context.event.id);
  if (!view?.run) return plainResponse(409, "There is no active schedule yet. Run matching and activate a run first.");

  // Audit first: once the stream starts, the response is committed.
  await recordExport({
    eventId: context.event.id,
    adminId: context.adminId,
    kind: "schedules",
    runId: view.run.id,
    runVersion: view.run.version,
  });
  return fileResponse(toWebStream(schedulesZip(view)), "schedules", context.year);
}
