import { and, desc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, imports, type Import } from "@/db/schema";
import {
  importKindSchema,
  importValidationReportSchema,
  type ImportKind,
  type ImportState,
  type ImportValidationReport,
} from "@/lib/schemas/import";
import { importStateFor } from "./validate";

export type ImportSummary = {
  id: string;
  eventId: string;
  kind: ImportKind;
  fileName: string;
  status: Import["status"];
  state: ImportState;
  rowCount: number | null;
  counts: ImportValidationReport["counts"] | null;
  createdAt: Date;
  appliedAt: Date | null;
  createdBy: string | null;
  createdByName: string | null;
};

export type ImportDetail = ImportSummary & { report: ImportValidationReport | null };

export const importKinds: readonly ImportKind[] = importKindSchema.options;

/** Older or hand-written reports that do not match the current shape read as null. */
export function parseReport(validation: unknown): ImportValidationReport | null {
  const parsed = importValidationReportSchema.safeParse(validation);
  return parsed.success ? parsed.data : null;
}

type JoinedRow = { import: Import; createdByName: string | null };

function toSummary(row: JoinedRow, report: ImportValidationReport | null): ImportSummary {
  return {
    id: row.import.id,
    eventId: row.import.eventId,
    kind: row.import.kind,
    fileName: row.import.fileName,
    status: row.import.status,
    state: importStateFor(row.import.status, report),
    rowCount: row.import.rowCount,
    counts: report?.counts ?? null,
    createdAt: row.import.createdAt,
    appliedAt: row.import.appliedAt,
    createdBy: row.import.createdBy,
    createdByName: row.createdByName,
  };
}

function toDetail(row: JoinedRow): ImportDetail {
  const report = parseReport(row.import.validation);
  return { ...toSummary(row, report), report };
}

function selectImports(db: Db) {
  return db
    .select({ import: imports, createdByName: admins.name })
    .from(imports)
    .leftJoin(admins, eq(imports.createdBy, admins.id));
}

/** Every import of the event, newest first. */
export async function listImports(eventId: string, db: Db = getDb()): Promise<ImportSummary[]> {
  const rows = await selectImports(db).where(eq(imports.eventId, eventId)).orderBy(desc(imports.createdAt), desc(imports.id));
  return rows.map((row) => toSummary(row, parseReport(row.import.validation)));
}

export async function getImport(id: string, db: Db = getDb()): Promise<ImportDetail | null> {
  const [row] = await selectImports(db).where(eq(imports.id, id)).limit(1);
  return row ? toDetail(row) : null;
}

/** The latest import per kind, for the upload cards. Kinds never uploaded are null. */
export async function getImportStatusByKind(
  eventId: string,
  db: Db = getDb(),
): Promise<Record<ImportKind, ImportSummary | null>> {
  const latest = Object.fromEntries(importKinds.map((kind) => [kind, null])) as Record<ImportKind, ImportSummary | null>;
  for (const kind of importKinds) {
    const [row] = await selectImports(db)
      .where(and(eq(imports.eventId, eventId), eq(imports.kind, kind)))
      .orderBy(desc(imports.createdAt), desc(imports.id))
      .limit(1);
    latest[kind] = row ? toSummary(row, parseReport(row.import.validation)) : null;
  }
  return latest;
}

export type MatchingReadiness = {
  /** Every required kind has an applied import. */
  ready: boolean;
  applied: ImportKind[];
  /** Kinds with no import at all. */
  missing: ImportKind[];
  /** Kinds whose latest import is not applied yet, with its state. */
  pending: { kind: ImportKind; importId: string; state: ImportState }[];
};

/** Matching needs the roster and all three ranking files applied. */
export async function readinessForMatching(eventId: string, db: Db = getDb()): Promise<MatchingReadiness> {
  const byKind = await getImportStatusByKind(eventId, db);
  const applied: ImportKind[] = [];
  const missing: ImportKind[] = [];
  const pending: MatchingReadiness["pending"] = [];
  for (const kind of importKinds) {
    const latest = byKind[kind];
    if (!latest) {
      missing.push(kind);
    } else if (latest.state === "applied") {
      applied.push(kind);
    } else {
      pending.push({ kind, importId: latest.id, state: latest.state });
    }
  }
  return { ready: missing.length === 0 && pending.length === 0, applied, missing, pending };
}
