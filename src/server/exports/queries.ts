import { and, desc, eq, inArray, like, max, or } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, auditEvents } from "@/db/schema";
import { isEventEditable } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { findActiveRun } from "@/server/matching/runs";
import { eventYear } from "./common";
import { EXPORT_KINDS, exportAuditAction, exportFilename, needsRun, type ExportKind } from "./kinds";

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
  /** The schedule (run or its version) moved since the last export. Only the three schedule files set it. */
  scheduleChanged: boolean;
  /**
   * What the file lists changed since the last export: people or links for the access list, people or the
   * schedule for the two full lists (they hold appointment counts). Never set for the three schedule files.
   */
  listChanged: boolean;
};

export type ExportAvailability = {
  eventId: string;
  activeRun: { id: string; version: number } | null;
  locked: boolean;
  exports: Record<ExportKind, ExportState>;
};

/** Audit actions that change who is on a list or what their link is. */
// Retention deletes people, links, and schedules, so it dates every list.
const PEOPLE_ACTIONS = ["participant.%", "supplier.%", "import.apply", "token.%", "event.retention_delete"];
/** Audit actions that change appointments, which the full lists count. */
const SCHEDULE_ACTIONS = ["appointment.%", "matching.%", "schedule.%"];
/** Sends change the full lists' "Changed since last email" column. */
const EMAIL_ACTIONS = ["email.send", "email.resend"];

/** The audit actions that make an exported list out of date, by kind. The schedule files compare run versions instead. */
const LIST_CHANGE_ACTIONS: Partial<Record<ExportKind, string[]>> = {
  access_list: PEOPLE_ACTIONS,
  participants_full: [...PEOPLE_ACTIONS, ...SCHEDULE_ACTIONS, ...EMAIL_ACTIONS],
  suppliers_full: [...PEOPLE_ACTIONS, ...SCHEDULE_ACTIONS, ...EMAIL_ACTIONS],
};

/** True when an audit action (an exact name) matches one of the patterns (`%` ends a prefix). */
function matchesAction(action: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("%") ? action.startsWith(p.slice(0, -1)) : action === p));
}

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
  const [run, rows, changes] = await Promise.all([
    findActiveRun(db, eventId),
    db
      .selectDistinctOn([auditEvents.action], {
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
      // DISTINCT ON keeps the first row per action: the newest, then the highest id on a tie.
      .orderBy(auditEvents.action, desc(auditEvents.createdAt), desc(auditEvents.id)),
    // When each kind of change last happened, for the lists that go stale when people or links change.
    db
      .select({ action: auditEvents.action, at: max(auditEvents.createdAt) })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventId, eventId),
          or(...[...PEOPLE_ACTIONS, ...SCHEDULE_ACTIONS, ...EMAIL_ACTIONS].map((p) => like(auditEvents.action, p))),
        ),
      )
      .groupBy(auditEvents.action),
  ]);

  const locked = !isEventEditable(event);
  const year = eventYear(event.eventDate);
  const exports = {} as Record<ExportKind, ExportState>;
  for (const kind of EXPORT_KINDS) {
    const latest = rows.find((r) => r.action === exportAuditAction(kind));
    const last: LastExport | null = latest
      ? { at: latest.createdAt, byName: latest.byName, ...readRunRef(latest.after) }
      : null;
    const reason =
      needsRun(kind) && !run ? NO_RUN_REASON : needsLock(kind) && !locked ? NOT_LOCKED_REASON : null;
    const scheduleChanged =
      kind !== "access_list" &&
      needsRun(kind) &&
      last !== null &&
      run !== null &&
      (last.runId !== run.id || last.runVersion !== run.version);
    const watched = LIST_CHANGE_ACTIONS[kind];
    const listChanged =
      watched !== undefined &&
      last !== null &&
      changes.some((c) => c.at !== null && c.at > last.at && matchesAction(c.action, watched));
    exports[kind] = {
      kind,
      filename: exportFilename(kind, year),
      available: reason === null,
      reason,
      last,
      scheduleChanged,
      listChanged,
    };
  }

  return { eventId, activeRun: run ? { id: run.id, version: run.version } : null, locked, exports };
}
