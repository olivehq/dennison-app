import { getDb, type Db } from "@/db/client";
import type { ContactType } from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { findActiveRun } from "@/server/matching/runs";
import { issueAccessList } from "@/server/tokens/queries";
import { recordExport } from "./actions";
import { toCsv } from "./common";
import { linkValue } from "./links";

export const ACCESS_COLUMNS = ["Name", "Email", "Type", "Company", "Title", "Contact type", "Link"];

/** The "Type" column: whether the contact is a buyer or speaks for a supplier. */
export function contactKindLabel(contactType: ContactType): string {
  return contactType === "buyer" ? "Buyer" : "Supplier";
}

/** The "Contact type" column: which supplier contact this is. Blank for buyers. */
export function supplierContactLabel(contactType: ContactType): string {
  return contactType === "supplier_admin" ? "Admin" : contactType === "supplier_attendee" ? "Attendee" : "";
}

/**
 * `Participant_Access_<year>.csv`, the email fallback (scope 2.4). Each
 * contact's current link is reused (D31, D59), so links already emailed keep
 * working. Contacts who never had a link, or whose link expired, get a new
 * one; a revoked link stays revoked and the row says "Link revoked". On an
 * archived event nothing is issued. Audited as `export.access_list` in the
 * same transaction as the new links, with how many were issued, so a failed
 * audit leaves no unlogged links behind.
 */
export async function accessCsv(
  eventId: string,
  adminId: string,
  db: Db = getDb(),
): Promise<ActionResult<{ csv: string; count: number; runVersion: number }>> {
  const run = await findActiveRun(db, eventId);
  if (!run) return fail("conflict", "There is no active schedule yet. Run matching and activate a run first.");
  const issued = await db.transaction(async (tx) => {
    const list = await issueAccessList(tx, eventId);
    if (!list.ok) return list;
    const { rows, linksIssued } = list.data;
    await recordExport(
      {
        eventId,
        adminId,
        kind: "access_list",
        runId: run.id,
        runVersion: run.version,
        details: { contacts: rows.length, withoutLink: rows.filter((r) => !r.link?.url).length, linksIssued },
      },
      tx,
    );
    return ok(rows);
  });
  if (!issued.ok) return issued;
  const rows = issued.data;
  const csv = toCsv(
    ACCESS_COLUMNS,
    rows.map((r) => [
      r.name,
      r.email,
      contactKindLabel(r.contactType),
      r.company,
      r.title ?? "",
      supplierContactLabel(r.contactType),
      linkValue(r.link),
    ]),
  );
  return ok({ csv, count: rows.length, runVersion: run.version });
}
