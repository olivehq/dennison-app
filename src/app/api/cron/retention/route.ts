import { getDb } from "@/db/client";
import { rejectCronRequest } from "@/lib/cron-auth";
import { env } from "@/lib/env";
import { deleteExpiredParticipantData } from "@/server/events/retention";
import { drainFileDeletions } from "@/server/files/cleanup";

/**
 * Daily at 09:00 UTC from vercel.json: deletes participant data 90 days after
 * each event (SOW 4), then retries every queued file deletion that is due (D184).
 */
export async function GET(request: Request) {
  const rejected = rejectCronRequest(request.headers.get("authorization"), env.CRON_SECRET);
  if (rejected) return rejected;

  const db = getDb();
  const results = await deleteExpiredParticipantData(db);
  const files = await drainFileDeletions(db);
  if (files.pending > 0) {
    console.warn(`[retention] ${files.pending} stored file(s) are still queued for deletion, ${files.failing} of them failing repeatedly.`);
  }
  return Response.json(
    {
      events: results.length,
      results: results.map((r) => ({ eventId: r.eventId, deleted: r.deleted })),
      files: { deleted: files.deleted, failed: files.failed.length, pending: files.pending, failing: files.failing },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
