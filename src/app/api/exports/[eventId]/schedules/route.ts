import { getDb } from "@/db/client";
import { exportRoute } from "@/server/exports/http";
import { loadLinkRows } from "@/server/exports/links";
import { schedulesZip, toWebStream } from "@/server/exports/schedules";

export function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/schedules">) {
  return exportRoute("schedules", ctx.params, async ({ event }, view) => {
    const links = await loadLinkRows(getDb(), event.id);
    return { body: toWebStream(schedulesZip(view, links)) };
  });
}
