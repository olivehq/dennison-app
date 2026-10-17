import { recordExport } from "@/server/exports/actions";
import { fileResponse, loadExportContext, plainResponse } from "@/server/exports/http";
import { suppliersFullCsv } from "@/server/exports/roster";

/** Every supplier, withdrawn included. Needs no active run. */
export async function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/suppliers">) {
  const { eventId } = await ctx.params;
  const loaded = await loadExportContext(eventId, "suppliers_full");
  if (!loaded.ok) return loaded.response;
  const { context } = loaded;

  const result = await suppliersFullCsv(context.event.id);
  if (!result.ok) return plainResponse(404, result.error.message);
  await recordExport({
    eventId: context.event.id,
    adminId: context.adminId,
    kind: "suppliers_full",
    details: { rows: result.data.count },
  });
  return fileResponse(result.data.csv, "suppliers_full", context.year);
}
