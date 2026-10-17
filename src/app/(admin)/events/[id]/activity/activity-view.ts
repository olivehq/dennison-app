import { formatEventDate } from "@/lib/time";
import type { AuditActionGroup } from "@/server/audit/describe";
import type { ActivityParams, ActivityRow, ActivitySummary } from "@/server/audit/queries";

export type ActivityFilterParams = Omit<ActivityParams, "page">;

const FILTER_KEYS = ["person", "admin", "type", "from", "to"] as const;

/** The query string for these filters and page, "" when there are none. Filters keep their URL names. */
export function activityQuery(params: ActivityFilterParams, page = 1): string {
  const query = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params[key];
    if (value) query.set(key, value);
  }
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return search ? `?${search}` : "";
}

export function isFiltered(params: ActivityFilterParams): boolean {
  return FILTER_KEYS.some((key) => Boolean(params[key]));
}

function sameFilters(a: ActivityFilterParams, b: ActivityFilterParams): boolean {
  return FILTER_KEYS.every((key) => (a[key] ?? undefined) === (b[key] ?? undefined));
}

export type SummaryStat = {
  key: "changes" | "schedule" | "imports" | "admins";
  value: number;
  label: string;
  /** The filters clicking the stat applies. Null when there is nothing to show. */
  filters: ActivityFilterParams | null;
  /** True when the log already shows exactly these filters. */
  active: boolean;
  /** For "admins active today" with more than one admin: pick one. */
  choices?: { label: string; filters: ActivityFilterParams; active: boolean }[];
};

/**
 * The four numbers above the log. Each one is a shortcut that replaces the
 * current filters with "today" plus its own filter, so the count it shows is
 * the length of the log it opens.
 */
export function summaryStats(summary: ActivitySummary, current: ActivityFilterParams): SummaryStat[] {
  const today = { from: summary.today, to: summary.today };
  const stat = (key: SummaryStat["key"], value: number, label: string, filters: ActivityFilterParams): SummaryStat => ({
    key,
    value,
    label,
    filters: value > 0 ? filters : null,
    active: value > 0 && sameFilters(filters, current),
  });
  const admins = summary.admins;
  const adminFilters = admins.map((a) => ({ ...today, admin: a.id }));
  return [
    stat("changes", summary.changes, summary.changes === 1 ? "change today" : "changes today", today),
    stat("schedule", summary.scheduleEdits, summary.scheduleEdits === 1 ? "schedule edit today" : "schedule edits today", {
      ...today,
      type: "schedule",
    }),
    stat("imports", summary.imports, summary.imports === 1 ? "import change today" : "import changes today", {
      ...today,
      type: "imports",
    }),
    {
      key: "admins",
      value: admins.length,
      label: admins.length === 1 ? "admin active today" : "admins active today",
      filters: admins.length === 1 ? adminFilters[0] : null,
      active: adminFilters.some((filters) => sameFilters(filters, current)),
      choices:
        admins.length > 1
          ? admins.map((a, i) => ({ label: a.name, filters: adminFilters[i], active: sameFilters(adminFilters[i], current) }))
          : undefined,
    },
  ];
}

export type DayGroup<Row> = {
  day: string;
  /** "Today", "Yesterday", or the full date. */
  label: string;
  /** The full date, shown beside "Today" and "Yesterday". */
  date: string;
  rows: Row[];
};

/** "Today", "Yesterday", else the full date. */
export function dayLabel(day: string, summary: Pick<ActivitySummary, "today" | "yesterday">, timezone: string): string {
  if (day === summary.today) return "Today";
  if (day === summary.yesterday) return "Yesterday";
  return formatEventDate(day, timezone);
}

/** Consecutive rows on the same day of the event's timezone, in the order given (newest first). */
export function groupByDay<Row extends Pick<ActivityRow, "day">>(
  rows: Row[],
  summary: Pick<ActivitySummary, "today" | "yesterday">,
  timezone: string,
): DayGroup<Row>[] {
  const groups: DayGroup<Row>[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.day === row.day) last.rows.push(row);
    else {
      groups.push({ day: row.day, label: dayLabel(row.day, summary, timezone), date: formatEventDate(row.day, timezone), rows: [row] });
    }
  }
  return groups;
}

export type EntryTone = "schedule" | "imports" | "removal" | "quiet";

/** Actions that take something away: shown in the destructive tint whatever their area. */
const REMOVAL_ACTIONS = new Set([
  "appointment.remove",
  "participant.withdraw",
  "supplier.withdraw",
  "token.revoke",
  "import.delete",
  "matching.clear",
  "event.retention_delete",
  "admin.invite_revoke",
]);

/**
 * The icon tile's tint. Teal (the hotel tint) for the schedule and what
 * builds it (edits, matching, lock), marigold (the business tint) for files
 * coming in, oxblood for removals, muted for everything else.
 */
export function entryTone(row: Pick<ActivityRow, "action" | "area">): EntryTone {
  if (REMOVAL_ACTIONS.has(row.action)) return "removal";
  const area: AuditActionGroup | null = row.area;
  if (area === "schedule" || area === "matching" || area === "lock") return "schedule";
  if (area === "imports") return "imports";
  return "quiet";
}
