import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { admins, imports, nameAliases, participants, rankings, suppliers, type Import } from "@/db/schema";
import { compareNames } from "@/lib/names";
import {
  importKindSchema,
  importValidationReportSchema,
  type ImportKind,
  type ImportState,
  type EntityType,
  type ImportValidationReport,
  type RankingKind,
} from "@/lib/schemas/import";
import { cachePerRender } from "@/server/render-cache";
import { fullNameFor } from "@/server/roster/display-name";
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

/**
 * A saved name mapping that can change how this event's files read.
 * `event`: this event's alias. `crossYear` on it means the cross-year copy
 * this save wrote (same person) exists and is removed with it. `cross_year`:
 * a global alias (D76) another save wrote, listed because its name is on this
 * event's roster; removing it removes it for every event.
 */
export type SavedNameMapping = {
  id: string;
  scope: "event" | "cross_year";
  rawText: string;
  entityType: EntityType;
  /** Who it resolves to on this event's roster. */
  mapsTo: string;
  source: "auto" | "manual";
  crossYear: boolean;
};

/** Every saved name mapping that applies to this event, sorted by the text in the file. */
export async function listSavedNameMappings(eventId: string, db: Db = getDb()): Promise<SavedNameMapping[]> {
  const [eventRows, globalRows, people, supplierRows] = await Promise.all([
    db.select().from(nameAliases).where(eq(nameAliases.eventId, eventId)),
    db.select().from(nameAliases).where(and(isNull(nameAliases.eventId), isNotNull(nameAliases.canonicalName))),
    db
      .select({ id: participants.id, firstName: participants.firstName, lastName: participants.lastName, organization: participants.organization })
      .from(participants)
      .where(eq(participants.eventId, eventId)),
    db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.eventId, eventId)),
  ]);
  const roster: { id: string; entityType: EntityType; canonical: string; label: string }[] = [
    ...people.map((person) => {
      const full = fullNameFor(person);
      return { id: person.id, entityType: "buyer" as const, canonical: full, label: person.organization ? `${full} (${person.organization})` : full };
    }),
    ...supplierRows.map((supplier) => ({ id: supplier.id, entityType: "supplier" as const, canonical: supplier.name, label: supplier.name })),
  ];
  const labelOf = new Map(roster.map((entity) => [entity.id, entity.label]));
  const byCanonical = new Map<string, string[]>();
  for (const entity of roster) {
    const key = `${entity.entityType}:${entity.canonical.trim().toLowerCase()}`;
    byCanonical.set(key, [...(byCanonical.get(key) ?? []), entity.id]);
  }
  const globalKey = (entityType: EntityType, rawText: string) => `${entityType}:${rawText.trim().toLowerCase()}`;
  const globalByKey = new Map(globalRows.map((row) => [globalKey(row.entityType, row.rawText), row]));

  const mappings: SavedNameMapping[] = [];
  const ownedGlobals = new Set<string>();
  for (const row of eventRows) {
    const mapsTo = labelOf.get(row.entityId);
    // An alias for someone no longer on the roster resolves nothing.
    if (!mapsTo) continue;
    const copy = globalByKey.get(globalKey(row.entityType, row.rawText));
    const crossYear = copy !== undefined && copy.entityId === row.entityId;
    if (crossYear) ownedGlobals.add(copy.id);
    mappings.push({ id: row.id, scope: "event", rawText: row.rawText, entityType: row.entityType, mapsTo, source: row.source, crossYear });
  }
  for (const row of globalRows) {
    if (ownedGlobals.has(row.id)) continue;
    // Resolution uses a cross-year alias only when its name is exactly one entity here.
    const ids = byCanonical.get(globalKey(row.entityType, row.canonicalName!)) ?? [];
    if (ids.length !== 1) continue;
    mappings.push({
      id: row.id,
      scope: "cross_year",
      rawText: row.rawText,
      entityType: row.entityType,
      mapsTo: labelOf.get(ids[0])!,
      source: row.source,
      crossYear: true,
    });
  }
  return mappings.sort((a, b) => compareNames(a.rawText, b.rawText) || compareNames(a.mapsTo, b.mapsTo));
}
