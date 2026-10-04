import { accessCsv } from "@/server/exports/access";
import { fileResponse, isSameOrigin, loadExportContext, plainResponse } from "@/server/exports/http";

/**
 * POST only: generating the list writes. Contacts keep their current link and
 * only those without a usable one get a new token (D59, which superseded the
 * rotate-everything rule of D31).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/exports/[eventId]/access">) {
  if (!isSameOrigin(request)) return plainResponse(403, "Cross-site requests are not allowed.");
  const { eventId } = await ctx.params;
  const loaded = await loadExportContext(eventId, "access_list");
  if (!loaded.ok) return loaded.response;
  const { context } = loaded;

  const result = await accessCsv(context.event.id, context.adminId);
  if (!result.ok) return plainResponse(result.error.code === "not_found" ? 404 : 409, result.error.message);
  return fileResponse(result.data.csv, "access_list", context.year);
}
