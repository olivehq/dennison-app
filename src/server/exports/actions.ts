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
  /** The active run the file was built from. Omit both for exports that need no run (`needsRun`). */
  runId?: string;
  runVersion?: number;
  /** Extra facts for the log, e.g. how many links an access list rotated. */
  details?: Record<string, unknown>;
};

export async function recordExport(input: RecordExportInput, db: Db = getDb()): Promise<void> {
  const hasRun = input.runId !== undefined;
  await recordAudit(db, {
    eventId: input.eventId,
    adminId: input.adminId,
    action: exportAuditAction(input.kind),
    entityType: hasRun ? "match_run" : "event",
    entityId: hasRun ? input.runId : input.eventId,
    after: hasRun ? { runId: input.runId, runVersion: input.runVersion, ...input.details } : { ...input.details },
  });
}
