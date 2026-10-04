import { getDb, type Db } from "@/db/client";
import { recordAudit } from "@/server/audit/audit";
import { exportAuditAction, type ExportKind } from "./kinds";

/**
 * Not a `'use server'` file. Exports are Route Handlers (they stream files),
 * and they call this after building the file. The audit row is what the
 * exports page reads for "Generated ... by ..." and for the
 * "Schedule changed since this export" warning.
 */

export type RecordExportInput = {
  eventId: string;
  adminId: string;
  kind: ExportKind;
  runId: string;
  runVersion: number;
  /** Extra facts for the log, e.g. how many links an access list rotated. */
  details?: Record<string, unknown>;
};

export async function recordExport(input: RecordExportInput, db: Db = getDb()): Promise<void> {
  await recordAudit(db, {
    eventId: input.eventId,
    adminId: input.adminId,
    action: exportAuditAction(input.kind),
    entityType: "match_run",
    entityId: input.runId,
    after: { runId: input.runId, runVersion: input.runVersion, ...input.details },
  });
}
