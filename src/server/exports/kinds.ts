/** The four exports (scope 2.4) and the names they download as. */

export const EXPORT_KINDS = ["master", "schedules", "report", "access_list"] as const;
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
  }
}

export const EXPORT_CONTENT_TYPES: Record<ExportKind, string> = {
  master: "text/csv; charset=utf-8",
  schedules: "application/zip",
  report: "text/plain; charset=utf-8",
  access_list: "text/csv; charset=utf-8",
};
