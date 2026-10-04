import { getDb, type Db } from "@/db/client";
import type { ContactType } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { findActiveRun } from "@/server/matching/runs";
import { issueAccessList } from "@/server/tokens/queries";
import { recordExport } from "./actions";
import { toCsv } from "./common";

export const ACCESS_COLUMNS = ["Name", "Email", "Contact type", "Link"];

export const CONTACT_TYPE_LABELS: Record<ContactType, string> = {
  buyer: "Buyer",
  supplier_admin: "Supplier admin",
  supplier_attendee: "Supplier attendee",
};

/**
 * `Participant_Access_<year>.csv`, the email fallback (scope 2.4). Each
 * contact's current link is reused and only contacts without one get a new
 * token (D31, D59), so links already emailed keep working. Audited as
 * `export.access_list`.
 */
export async function accessCsv(
  eventId: string,
  adminId: string,
  db: Db = getDb(),
): Promise<ActionResult<{ csv: string; count: number; runVersion: number }>> {
  const run = await findActiveRun(db, eventId);
  if (!run) return fail("conflict", "There is no active schedule yet. Run matching and activate a run first.");
  const issued = await issueAccessList(db, eventId);
  if (!issued.ok) return issued;
  const rows = issued.data;
  await recordExport(
    { eventId, adminId, kind: "access_list", runId: run.id, runVersion: run.version, details: { linksIssued: rows.length } },
    db,
  );
  const csv = toCsv(
    ACCESS_COLUMNS,
    rows.map((r) => [r.name, r.email, CONTACT_TYPE_LABELS[r.contactType], r.link]),
  );
  return ok({ csv, count: rows.length, runVersion: run.version });
}
