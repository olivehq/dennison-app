/**
 * The four exports (scope 2.4) and the two full roster lists, with the names
 * they download as. The roster lists describe people, not the schedule, so they
 * need no active run (`needsRun`).
 */

export const EXPORT_KINDS = ["master", "schedules", "report", "access_list", "participants_full", "suppliers_full"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** The `audit_events.action` of a generated export. */
export function exportAuditAction(kind: ExportKind): `export.${ExportKind}` {
  return `export.${kind}`;
}

export function exportFilename(kind: ExportKind, year: string): string {
  switch (kind) {
    case "master":
      return `Master_Schedule_${year}_Final.csv`;
    case "schedules":
      return `AW_${year}_Schedules.zip`;
    case "report":
      return `Matching_Quality_Report_${year}.txt`;
    case "access_list":
      return `Participant_Access_${year}.csv`;
    case "participants_full":
      return `AW_${year}_Participants_Full.csv`;
    case "suppliers_full":
      return `AW_${year}_Suppliers_Full.csv`;
  }
}

export const EXPORT_CONTENT_TYPES: Record<ExportKind, string> = {
  master: "text/csv; charset=utf-8",
  schedules: "application/zip",
  report: "text/plain; charset=utf-8",
  access_list: "text/csv; charset=utf-8",
  participants_full: "text/csv; charset=utf-8",
  suppliers_full: "text/csv; charset=utf-8",
};

/** Exports that describe the active schedule. The roster lists work before any run exists. */
export function needsRun(kind: ExportKind): boolean {
  return kind !== "participants_full" && kind !== "suppliers_full";
}
