import { and, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, imports, rankings, type Import } from "@/db/schema";
import {
  importKindSchema,
  importValidationReportSchema,
  type ImportKind,
  type ImportState,
  type ImportValidationReport,
  type RankingKind,
} from "@/lib/schemas/import";
import { cachePerRender } from "@/server/render-cache";
import { importStateFor, rankingRoles } from "./validate";

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

/**
 * The latest import per kind that isn't ignored, for the upload cards, the
 * sidebar's waiting count, and matching readiness. An ignored file is
 * skipped, so the file before it counts again. Kinds with no such import are
 * null. One query, shared per render; a transaction reads fresh.
 */
export function getImportStatusByKind(
  eventId: string,
  db: Db = getDb(),
): Promise<Record<ImportKind, ImportSummary | null>> {
  return latestImportsByKind(db, eventId);
}

const latestImportsByKind = cachePerRender(
  async (db: Db, eventId: string): Promise<Record<ImportKind, ImportSummary | null>> => {
    const rows = await db
      .selectDistinctOn([imports.kind], { import: imports, createdByName: admins.name })
      .from(imports)
      .leftJoin(admins, eq(imports.createdBy, admins.id))
      .where(and(eq(imports.eventId, eventId), ne(imports.status, "ignored")))
      .orderBy(imports.kind, desc(imports.createdAt), desc(imports.id));
    const latest = Object.fromEntries(importKinds.map((kind) => [kind, null])) as Record<ImportKind, ImportSummary | null>;
    for (const row of rows) latest[row.import.kind] = toSummary(row, parseReport(row.import.validation));
    return latest;
  },
);

/**
 * The rankings of these rankers that an applied import of this kind wrote:
 * what applying another file of the kind replaces (replace per ranker).
 * Rankings with no import, or from another kind, never match.
 */
export function rankingsOfKindFor(eventId: string, kind: RankingKind, rankerIds: string[]): SQL {
  return and(
    eq(rankings.eventId, eventId),
    eq(rankings.rankerType, rankingRoles(kind).rankerType),
    inArray(rankings.rankerId, rankerIds),
    sql`${rankings.importId} in (select ${imports.id} from ${imports} where ${imports.eventId} = ${eventId} and ${imports.kind} = ${kind} and ${imports.status} = 'applied')`,
  )!;
}

/** How many current rankings applying a file with these rankers would replace, for the apply confirmation. */
export async function countRankingsToReplace(
  eventId: string,
  kind: RankingKind,
  rankerIds: string[],
  db: Db = getDb(),
): Promise<number> {
  if (rankerIds.length === 0) return 0;
  const [row] = await db.select({ n: count() }).from(rankings).where(rankingsOfKindFor(eventId, kind, rankerIds));
  return row?.n ?? 0;
}
