import { exportRoute } from "@/server/exports/http";
import { masterScheduleCsv } from "@/server/exports/master";

export function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/master">) {
  return exportRoute("master", ctx.params, async (_context, view) => ({
    body: masterScheduleCsv(view),
    details: { rows: view.appointments.length },
  }));
}
