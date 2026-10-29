import { exportRoute, plainResponse } from "@/server/exports/http";
import { suppliersFullCsv } from "@/server/exports/roster";

/** Every supplier, withdrawn included. Needs no active run. */
export function GET(_request: Request, ctx: RouteContext<"/api/exports/[eventId]/suppliers">) {
  return exportRoute("suppliers_full", ctx.params, async ({ event }) => {
    const result = await suppliersFullCsv(event.id);
    if (!result.ok) return plainResponse(404, result.error.message);
    return { body: result.data.csv, details: { rows: result.data.count } };
  });
}
