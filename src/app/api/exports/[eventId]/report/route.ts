import { exportRoute, plainResponse } from "@/server/exports/http";
import { qualityReportText } from "@/server/exports/report";

export function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/report">) {
  return exportRoute("report", ctx.params, async (_context, view) => {
    if (!view.run.stats) return plainResponse(409, "The active run has no statistics. Re-run matching to rebuild them.");
    return { body: qualityReportText(view, view.run.stats, view.event) };
  });
}
