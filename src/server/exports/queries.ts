import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, auditEvents } from "@/db/schema";
import { isEventEditable } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { findActiveRun } from "@/server/matching/runs";
import { eventYear } from "./common";
import { EXPORT_KINDS, exportAuditAction, exportFilename, type ExportKind } from "./kinds";

export type LastExport = {
  at: Date;
  byName: string | null;
  runId: string | null;
  runVersion: number | null;
};

export type ExportState = {
  kind: ExportKind;
  filename: string;
  available: boolean;
  /** Why the export is disabled. Null when available. */
  reason: string | null;
  last: LastExport | null;
  /** The schedule (run or its version) moved since the last export. Never set for the access list. */
  scheduleChanged: boolean;
};

export type ExportAvailability = {
  eventId: string;
  activeRun: { id: string; version: number } | null;
  locked: boolean;
  exports: Record<ExportKind, ExportState>;
};

const NO_RUN_REASON = "There is no active schedule yet. Run matching and activate a run first.";
const NOT_LOCKED_REASON = "Lock the schedule first. Participant links are issued at lock.";

/** Lock-dependent exports need a frozen schedule: locked, sent, or archived. */
export function needsLock(kind: ExportKind): boolean {
  return kind === "access_list";
}

function readRunRef(after: unknown): { runId: string | null; runVersion: number | null } {
  if (!after || typeof after !== "object") return { runId: null, runVersion: null };
  const record = after as Record<string, unknown>;
  return {
    runId: typeof record.runId === "string" ? record.runId : null,
    runVersion: typeof record.runVersion === "number" ? record.runVersion : null,
  };
}

/** What the exports page can offer, when each was last generated, and whether the schedule moved since. */
export async function exportAvailability(eventId: string, db: Db = getDb()): Promise<ExportAvailability | null> {
  const event = await getEvent(eventId, db);
  if (!event) return null;
  const [run, rows] = await Promise.all([
    findActiveRun(db, eventId),
    db
      .select({
        action: auditEvents.action,
        after: auditEvents.after,
        createdAt: auditEvents.createdAt,
        byName: admins.name,
      })
      .from(auditEvents)
      .leftJoin(admins, eq(admins.id, auditEvents.adminId))
      .where(
        and(
          eq(auditEvents.eventId, eventId),
          inArray(auditEvents.action, EXPORT_KINDS.map(exportAuditAction)),
        ),
      )
      .orderBy(desc(auditEvents.createdAt)),
  ]);

  const locked = !isEventEditable(event);
  const year = eventYear(event.eventDate);
  const exports = {} as Record<ExportKind, ExportState>;
  for (const kind of EXPORT_KINDS) {
    const latest = rows.find((r) => r.action === exportAuditAction(kind));
    const last: LastExport | null = latest
      ? { at: latest.createdAt, byName: latest.byName, ...readRunRef(latest.after) }
      : null;
    const reason = !run ? NO_RUN_REASON : needsLock(kind) && !locked ? NOT_LOCKED_REASON : null;
    const scheduleChanged =
      kind !== "access_list" &&
      last !== null &&
      run !== null &&
      (last.runId !== run.id || last.runVersion !== run.version);
    exports[kind] = { kind, filename: exportFilename(kind, year), available: reason === null, reason, last, scheduleChanged };
  }

  return { eventId, activeRun: run ? { id: run.id, version: run.version } : null, locked, exports };
}
