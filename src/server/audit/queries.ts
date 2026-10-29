import { and, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { admins, appointments, auditEvents, participants, suppliers, type AuditEvent, type Event } from "@/db/schema";
import { compareNames } from "@/lib/names";
import { endOfDayInTimezone, formatTimeOfDay, formatTimestamp, isoDateInTimezone } from "@/lib/time";
import { isEventEditable } from "@/server/events/editable";
import { getEvent } from "@/server/events/queries";
import { findActiveRun } from "@/server/matching/runs";
import { displayNameFor } from "@/server/roster/display-name";
import { UNDOABLE_ACTIONS, undoBlocker, undoNote } from "@/server/schedule/edits";
import { DEFAULT_AUDIT_PAGE_SIZE, countAudit, listAudit, type AuditFilters } from "./audit";
import { AUDIT_ACTION_GROUPS, auditActionGroupOf, describeAudit, isAuditActionGroup, type AuditActionGroup } from "./describe";

/** The activity page's filters, as they sit in the URL. Bad values are dropped, not errors. */
export type ActivityParams = {
  person?: string;
  admin?: string;
  type?: AuditActionGroup;
  from?: string;
  to?: string;
  page: number;
};

const isoDate = z.iso.date();

export function parseActivityParams(raw: Record<string, string | string[] | undefined>): ActivityParams {
  const one = (key: string) => {
    const value = raw[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const page = Number(one("page"));
  const date = (key: string) => {
    const value = one(key);
    return value && isoDate.safeParse(value).success ? value : undefined;
  };
  const person = one("person");
  const type = one("type");
  return {
    person: person && z.uuid().safeParse(person).success ? person : undefined,
    admin: one("admin"),
    type: isAuditActionGroup(type) ? type : undefined,
    from: date("from"),
    to: date("to"),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export type ActivityDetail = { key: string; label: string; before: string | null; after: string | null };

export type ActivityUndo = { available: true } | { available: false; reason: string };

export type ActivityRow = {
  id: string;
  action: string;
  /** The filter group the action belongs to, null for actions no group lists. */
  area: AuditActionGroup | null;
  when: string;
  /** The calendar date in the event's timezone, "2026-11-10", for grouping by day. */
  day: string;
  /** The time of day in the event's timezone, "3:10 PM". */
  time: string;
  who: string;
  sentence: string;
  note: string | null;
  details: ActivityDetail[];
  /** Null when the row is not a schedule edit that undo understands. */
  undo: ActivityUndo | null;
};

export type ActivityOption = { value: string; label: string; group: "Buyers" | "Suppliers" };

/**
 * Today's numbers above the log, today being the event timezone's calendar
 * day. Each count uses the same filter its shortcut applies, so the number
 * and the filtered log never disagree.
 */
export type ActivitySummary = {
  /** Today in the event's timezone, "2026-11-10". */
  today: string;
  /** The day before, for the "Yesterday" heading. */
  yesterday: string;
  changes: number;
  scheduleEdits: number;
  imports: number;
  /** Admins with at least one change today, sorted by name. */
  admins: { id: string; name: string }[];
};

export type ActivityPage = {
  event: Pick<Event, "id" | "timezone" | "status">;
  params: ActivityParams;
  summary: ActivitySummary;
  rows: ActivityRow[];
  total: number;
  page: number;
  pageSize: number;
  people: ActivityOption[];
  admins: { id: string; name: string }[];
};

const HIDDEN_DETAIL_KEYS = new Set(["runId", "id", "eventId", "createdAt", "updatedAt"]);

const DETAIL_LABELS: Record<string, string> = {
  buyerId: "Buyer",
  supplierId: "Supplier",
  entityId: "Person",
  pinKept: "Pin kept",
  deskNumber: "Desk",
  deskOverride: "Desk kept at lock",
  biztechOptIn: "Biztech opt-in",
};

/** "supplierRank" -> "Supplier rank". */
function detailLabel(key: string): string {
  if (DETAIL_LABELS[key]) return DETAIL_LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function show(value: unknown, names: ReadonlyMap<string, string>): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return names.get(value) ?? value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return JSON.stringify(value);
}

/** One level of before and after side by side, ids replaced by names. */
export function auditDetails(row: Pick<AuditEvent, "before" | "after">, names: ReadonlyMap<string, string>): ActivityDetail[] {
  const asBag = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : v === null || v === undefined ? {} : { value: v };
  const before = asBag(row.before);
  const after = asBag(row.after);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !HIDDEN_DETAIL_KEYS.has(k));
  return keys.map((key) => ({ key, label: detailLabel(key), before: show(before[key], names), after: show(after[key], names) }));
}

function filtersFor(params: ActivityParams, timezone: string): AuditFilters {
  const filters: AuditFilters = {};
  if (params.admin) filters.adminId = params.admin;
  if (params.person) filters.personId = params.person;
  if (params.type) filters.actions = AUDIT_ACTION_GROUPS[params.type].actions;
  // Whole days in the event's timezone: from the first millisecond of `from` to the last of `to`.
  if (params.from) filters.from = new Date(endOfDayInTimezone(params.from, timezone, -1).getTime() + 1);
  if (params.to) filters.to = new Date(endOfDayInTimezone(params.to, timezone).getTime() + 1);
  return filters;
}

function runIdOf(row: AuditEvent): string | null {
  for (const side of [row.before, row.after]) {
    if (side && typeof side === "object" && typeof (side as { runId?: unknown }).runId === "string") {
      return (side as { runId: string }).runId;
    }
  }
  return null;
}

/** Today's total and the schedule and import counts, in one query with the same filters the shortcuts use. */
async function countToday(eventId: string, timezone: string, today: string, db: Db) {
  const filters = filtersFor({ from: today, to: today, page: 1 }, timezone);
  const { total, subsets } = await countAudit(
    {
      eventId,
      filters,
      subsets: { schedule: AUDIT_ACTION_GROUPS.schedule.actions, imports: AUDIT_ACTION_GROUPS.imports.actions },
    },
    db,
  );
  return { changes: total, scheduleEdits: subsets.schedule, imports: subsets.imports };
}

async function adminIdsActiveToday(eventId: string, timezone: string, today: string, db: Db): Promise<string[]> {
  const { from, to } = filtersFor({ from: today, to: today, page: 1 }, timezone);
  const rows = await db
    .selectDistinct({ adminId: auditEvents.adminId })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.eventId, eventId), gte(auditEvents.createdAt, from!), lt(auditEvents.createdAt, to!), isNotNull(auditEvents.adminId)),
    );
  return rows.map((r) => r.adminId!);
}

/** `now` is injectable for tests; it decides what "today" is. */
export async function getActivityPage(
  eventId: string,
  params: ActivityParams,
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<ActivityPage | null> {
  const event = await getEvent(eventId, db);
  if (!event) return null;
  const today = isoDateInTimezone(now, event.timezone);
  const yesterday = isoDateInTimezone(endOfDayInTimezone(today, event.timezone, -1), event.timezone);

  const [list, buyerRows, supplierRows, adminRows, activeRun, todayCounts, activeAdminIds] = await Promise.all([
    listAudit(
      { eventId, filters: filtersFor(params, event.timezone), page: params.page, pageSize: DEFAULT_AUDIT_PAGE_SIZE },
      db,
    ),
    db
      .select({
        id: participants.id,
        firstName: participants.firstName,
        lastName: participants.lastName,
        organization: participants.organization,
        title: participants.title,
        displayName: participants.displayName,
        status: participants.status,
      })
      .from(participants)
      .where(eq(participants.eventId, eventId)),
    db.select({ id: suppliers.id, name: suppliers.name, status: suppliers.status }).from(suppliers).where(eq(suppliers.eventId, eventId)),
    db.select({ id: admins.id, name: admins.name }).from(admins),
    findActiveRun(db, eventId),
    countToday(eventId, event.timezone, today, db),
    adminIdsActiveToday(eventId, event.timezone, today, db),
  ]);

  const names = new Map<string, string>();
  for (const b of buyerRows) names.set(b.id, displayNameFor(b));
  for (const s of supplierRows) names.set(s.id, s.name);
  const adminNames = new Map(adminRows.map((a) => [a.id, a.name]));

  const undoable = list.rows.filter((r) => r.entityType === "appointment" && UNDOABLE_ACTIONS.has(r.action));
  const undone = new Set<string>();
  if (undoable.length > 0) {
    const notes = await db
      .select({ note: auditEvents.note })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventId, eventId),
          eq(auditEvents.action, "appointment.undo"),
          inArray(
            auditEvents.note,
            undoable.map((r) => undoNote(r.id)),
          ),
        ),
      );
    const byNote = new Map(undoable.map((r) => [undoNote(r.id), r.id]));
    for (const { note } of notes) {
      const id = note ? byNote.get(note) : undefined;
      if (id) undone.add(id);
    }
  }
  const editable = isEventEditable(event);

  // The meetings and withdrawals an undo would run into, read only when some row can still be undone.
  const needsCheck =
    editable && activeRun !== null && undoable.some((r) => !undone.has(r.id) && runIdOf(r) === activeRun.id);
  const current = needsCheck
    ? await db
        .select({ slot: appointments.slot, buyerId: appointments.buyerId, supplierId: appointments.supplierId })
        .from(appointments)
        .where(eq(appointments.runId, activeRun.id))
    : [];
  const withdrawn = new Map<string, "Participants" | "Suppliers">([
    ...buyerRows.filter((b) => b.status === "withdrawn").map((b) => [b.id, "Participants"] as const),
    ...supplierRows.filter((s) => s.status === "withdrawn").map((s) => [s.id, "Suppliers"] as const),
  ]);

  const undoFor = (row: AuditEvent): ActivityUndo | null => {
    if (row.entityType !== "appointment" || !UNDOABLE_ACTIONS.has(row.action)) return null;
    // Nothing to replay, for example after the retention job cleared the row.
    if (!runIdOf(row)) return null;
    if (undone.has(row.id)) return { available: false, reason: "This change was already undone." };
    if (!editable) {
      return {
        available: false,
        reason: event.status === "archived" ? "This event is archived." : "Unlock the schedule to undo changes.",
      };
    }
    if (!activeRun || runIdOf(row) !== activeRun.id) {
      return { available: false, reason: "This change belongs to a run that is no longer active." };
    }
    const blocked = undoBlocker({ before: row.before, after: row.after, current, withdrawn, name: (id) => names.get(id) ?? id });
    return blocked ? { available: false, reason: blocked } : { available: true };
  };

  const people: ActivityOption[] = [
    ...buyerRows.map((b) => ({ value: b.id, label: names.get(b.id)!, group: "Buyers" as const })),
    ...supplierRows.map((s) => ({ value: s.id, label: s.name, group: "Suppliers" as const })),
  ].sort((a, b) => a.group.localeCompare(b.group) || compareNames(a.label, b.label));

  return {
    event: { id: event.id, timezone: event.timezone, status: event.status },
    params,
    summary: {
      today,
      yesterday,
      ...todayCounts,
      admins: activeAdminIds
        .map((id) => ({ id, name: adminNames.get(id) ?? "A former admin" }))
        .sort((a, b) => compareNames(a.name, b.name)),
    },
    rows: list.rows.map((row) => {
      const sentence = describeAudit(row, names);
      // Undo notes are bookkeeping (D32); other notes show unless the sentence already quotes them.
      const note = row.note && row.action !== "appointment.undo" && !sentence.includes(row.note) ? row.note : null;
      return {
        id: row.id,
        action: row.action,
        area: auditActionGroupOf(row.action),
        when: formatTimestamp(row.createdAt, event.timezone),
        day: isoDateInTimezone(row.createdAt, event.timezone),
        time: formatTimeOfDay(row.createdAt, event.timezone),
        who: row.adminId ? (adminNames.get(row.adminId) ?? "A former admin") : "System",
        sentence,
        note,
        details: auditDetails(row, names),
        undo: undoFor(row),
      };
    }),
    total: list.total,
    page: list.page,
    pageSize: list.pageSize,
    people,
    admins: adminRows.sort((a, b) => compareNames(a.name, b.name)),
  };
}
