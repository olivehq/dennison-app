import { recordExport } from "@/server/exports/actions";
import { fileResponse, loadExportContext, plainResponse } from "@/server/exports/http";
import { qualityReportText } from "@/server/exports/report";
import { getScheduleView } from "@/server/schedule/views";

export async function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/report">) {
  const { eventId } = await ctx.params;
  const loaded = await loadExportContext(eventId, "report");
  if (!loaded.ok) return loaded.response;
  const { context } = loaded;
  const view = await getScheduleView(context.event.id);
  if (!view?.run) return plainResponse(409, "There is no active schedule yet. Run matching and activate a run first.");
  if (!view.run.stats) return plainResponse(409, "The active run has no statistics. Re-run matching to rebuild them.");

  const text = qualityReportText(view, view.run.stats, view.event);
  await recordExport({
    eventId: context.event.id,
    adminId: context.adminId,
    kind: "report",
    runId: view.run.id,
    runVersion: view.run.version,
  });
  return fileResponse(text, "report", context.year);
}
