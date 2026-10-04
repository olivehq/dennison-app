import { recordExport } from "@/server/exports/actions";
import { fileResponse, loadExportContext, plainResponse } from "@/server/exports/http";
import { masterScheduleCsv } from "@/server/exports/master";
import { getScheduleView } from "@/server/schedule/views";

export async function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/master">) {
  const { eventId } = await ctx.params;
  const loaded = await loadExportContext(eventId, "master");
  if (!loaded.ok) return loaded.response;
  const { context } = loaded;
  const view = await getScheduleView(context.event.id);
  if (!view?.run) return plainResponse(409, "There is no active schedule yet. Run matching and activate a run first.");

  const csv = masterScheduleCsv(view);
  await recordExport({
    eventId: context.event.id,
    adminId: context.adminId,
    kind: "master",
    runId: view.run.id,
    runVersion: view.run.version,
    details: { rows: view.appointments.length },
  });
  return fileResponse(csv, "master", context.year);
}
