import { getDb } from "@/db/client";
import { rejectCronRequest } from "@/lib/cron-auth";
import { env } from "@/lib/env";
import { deleteExpiredParticipantData } from "@/server/events/retention";

/** Daily at 09:00 UTC from vercel.json: deletes participant data 90 days after each event (SOW 4). */
export async function GET(request: Request) {
  const rejected = rejectCronRequest(request.headers.get("authorization"), env.CRON_SECRET);
  if (rejected) return rejected;

  const results = await deleteExpiredParticipantData(getDb());
  return Response.json(
    {
      events: results.length,
      results: results.map((r) => ({ eventId: r.eventId, deleted: r.deleted, fileErrors: r.fileErrors.length })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
