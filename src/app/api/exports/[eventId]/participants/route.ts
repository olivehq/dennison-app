import { recordExport } from "@/server/exports/actions";
import { fileResponse, loadExportContext, plainResponse } from "@/server/exports/http";
import { participantsFullCsv } from "@/server/exports/roster";

/** Every participant, withdrawn included. Needs no active run. */
export async function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/participants">) {
  const { eventId } = await ctx.params;
  const loaded = await loadExportContext(eventId, "participants_full");
  if (!loaded.ok) return loaded.response;
  const { context } = loaded;

  const result = await participantsFullCsv(context.event.id);
  if (!result.ok) return plainResponse(404, result.error.message);
  await recordExport({
    eventId: context.event.id,
    adminId: context.adminId,
    kind: "participants_full",
    details: { rows: result.data.count },
  });
  return fileResponse(result.data.csv, "participants_full", context.year);
}
