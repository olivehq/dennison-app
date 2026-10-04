import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  imports,
  nameAliases,
  participants,
  rankings,
  suppliers,
  type Event,
  type Import,
} from "@/db/schema";
import { fail, ok, type ActionResult } from "@/lib/errors";
import {
  isRankingKind,
  type EntityType,
  type ImportKind,
  type ImportState,
  type ImportValidationReport,
  type RankingKind,
} from "@/lib/schemas/import";
import { deleteFile, getFile, importFileKey, putFile } from "@/lib/storage";
import { recordAudit } from "@/server/audit/audit";
import { advanceStatus } from "@/server/events/status";
import { fullNameFor } from "@/server/roster/display-name";
import { loadEditableEvent } from "@/server/roster/editable";
import { revokeTokens } from "@/server/roster/roster";
import {
  isStructuralFailure,
  parseImportFile,
  type ParsedFile,
  type ParsedParticipant,
  type ParsedSupplier,
} from "./parsers";
import {
  analyzeRankings,
  failedReport,
  importStateFor,
  validateParsed,
  type RankingAnalysis,
  type ValidationContext,
} from "./validate";

export type CreateImportInput = {
  eventId: string;
  kind: ImportKind;
  filename: string;
  buffer: Buffer | Uint8Array;
  adminId: string;
};

export type ImportOutcome = { importId: string; state: ImportState; report: ImportValidationReport };

export type ApplySummary = {
  kind: ImportKind;
  created: number;
  updated: number;
  rankingsDeleted: number;
  rankingsWritten: number;
  optedIn: number;
  optedOut: number;
  aliasesSaved: number;
  /** True when this apply moved the event from draft to imported. */
  eventAdvanced: boolean;
};

const CONTENT_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
};

function contentTypeFor(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export async function loadContext(db: Db, eventId: string): Promise<ValidationContext> {
  const [participantRows, supplierRows, aliasRows, globalRows] = await Promise.all([
    db.select().from(participants).where(eq(participants.eventId, eventId)),
    db.select().from(suppliers).where(eq(suppliers.eventId, eventId)),
    db.select().from(nameAliases).where(eq(nameAliases.eventId, eventId)),
    db
      .select({ rawText: nameAliases.rawText, entityType: nameAliases.entityType, canonicalName: nameAliases.canonicalName })
      .from(nameAliases)
      .where(and(isNull(nameAliases.eventId), isNotNull(nameAliases.canonicalName))),
  ]);
  return {
    participants: participantRows,
    suppliers: supplierRows,
    aliases: aliasRows,
    globalAliases: globalRows.map((row) => ({ ...row, canonicalName: row.canonicalName! })),
  };
}

type GlobalAliasInput = {
  rawText: string;
  entityType: EntityType;
  entityId: string;
  canonicalName: string;
  source: "manual" | "auto";
};

/**
 * Keeps the cross-year copy of an alias (D76): `event_id` null, keyed by entity
 * type and lower-cased raw text, pointing at the entity's current name. A
 * manual mapping replaces an earlier one; an auto alias never overwrites.
 */
async function upsertGlobalAlias(db: Db, alias: GlobalAliasInput): Promise<void> {
  const conflict =
    alias.source === "manual"
      ? sql`do update set entity_id = excluded.entity_id, canonical_name = excluded.canonical_name, source = excluded.source`
      : sql`do nothing`;
  await db.execute(sql`
    insert into ${nameAliases} (raw_text, entity_type, entity_id, canonical_name, source)
    values (${alias.rawText}, ${alias.entityType}, ${alias.entityId}, ${alias.canonicalName}, ${alias.source})
    on conflict (entity_type, lower(raw_text)) where event_id is null ${conflict}
  `);
}

type Evaluation =
  | { status: "failed"; report: ImportValidationReport }
  | { status: "validated"; report: ImportValidationReport; parsed: ParsedFile };

async function evaluate(db: Db, eventId: string, kind: ImportKind, buffer: Buffer | Uint8Array): Promise<Evaluation> {
  const outcome = parseImportFile(kind, buffer);
  if (!outcome.ok) return { status: "failed", report: failedReport(outcome.message) };
  if (isStructuralFailure(outcome.parsed)) {
    return { status: "failed", report: failedReport(outcome.parsed.errors.map((error) => error.message).join(" ")) };
  }
  const context = await loadContext(db, eventId);
  return { status: "validated", report: validateParsed(kind, outcome.parsed, context), parsed: outcome.parsed };
}

/** Stores the file, parses and validates it, and records the import. Never throws for a bad file. */
export async function createImport(db: Db, input: CreateImportInput): Promise<ActionResult<ImportOutcome>> {
  const loaded = await loadEditableEvent(db, input.eventId);
  if (!loaded.ok) return loaded.error;

  const importId = randomUUID();
  const key = importFileKey(input.eventId, importId, input.filename);
  await putFile({ key, body: input.buffer, contentType: contentTypeFor(input.filename) });

  const evaluation = await evaluate(db, input.eventId, input.kind, input.buffer);
  const state = importStateFor(evaluation.status, evaluation.report);
  await db.transaction(async (tx) => {
    await tx.insert(imports).values({
      id: importId,
      eventId: input.eventId,
      kind: input.kind,
      fileKey: key,
      fileName: input.filename,
      status: evaluation.status,
      validation: evaluation.report,
      rowCount: evaluation.status === "failed" ? null : evaluation.report.counts.rows,
      createdBy: input.adminId,
    });
    await recordAudit(tx, {
      eventId: input.eventId,
      adminId: input.adminId,
      action: "import.create",
      entityType: "import",
      entityId: importId,
      after: { kind: input.kind, fileName: input.filename, state, counts: evaluation.report.counts },
    });
  });
  return ok({ importId, state, report: evaluation.report });
}

async function findImport(db: Db, importId: string): Promise<Import | null> {
  const [row] = await db.select().from(imports).where(eq(imports.id, importId)).limit(1);
  return row ?? null;
}

async function readStoredFile(row: Import): Promise<Buffer | null> {
  const stored = await getFile(row.fileKey);
  return stored?.body ?? null;
}

/** Re-parses the stored file against the current roster and aliases and updates the report. */
export async function revalidateImport(db: Db, row: Import): Promise<ImportState> {
  if (row.status === "applied") return "applied";
  const buffer = await readStoredFile(row);
  const evaluation: Evaluation = buffer
    ? await evaluate(db, row.eventId, row.kind, buffer)
    : { status: "failed", report: failedReport("The uploaded file is no longer in storage. Upload it again.") };
  await db
    .update(imports)
    .set({
      status: evaluation.status,
      validation: evaluation.report,
      rowCount: evaluation.status === "failed" ? null : evaluation.report.counts.rows,
    })
    .where(eq(imports.id, row.id));
  return importStateFor(evaluation.status, evaluation.report);
}

async function revalidatePending(db: Db, eventId: string): Promise<{ importId: string; kind: ImportKind; state: ImportState }[]> {
  const pending = await db
    .select()
    .from(imports)
    .where(and(eq(imports.eventId, eventId), eq(imports.status, "validated")));
  const results = [];
  for (const row of pending) {
    results.push({ importId: row.id, kind: row.kind, state: await revalidateImport(db, row) });
  }
  return results;
}

export type AliasMapping = { raw: string; entityType: EntityType; entityId: string };

export type SaveAliasInput = AliasMapping & { eventId: string; adminId: string };

export type SaveAliasesInput = { eventId: string; aliases: AliasMapping[]; adminId: string };

type RevalidatedImport = { importId: string; kind: ImportKind; state: ImportState };

/** The entity's current roster name (supplier name, buyer full name), or null when it isn't on this event's roster. */
async function entityCanonicalName(db: Db, eventId: string, entityType: EntityType, entityId: string): Promise<string | null> {
  if (entityType === "buyer") {
    const [row] = await db
      .select({ firstName: participants.firstName, lastName: participants.lastName })
      .from(participants)
      .where(and(eq(participants.id, entityId), eq(participants.eventId, eventId)))
      .limit(1);
    return row ? fullNameFor(row) : null;
  }
  const [row] = await db
    .select({ name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.id, entityId), eq(suppliers.eventId, eventId)))
    .limit(1);
  return row?.name ?? null;
}

/**
 * Maps raw names to entities (source manual) in one transaction, then
 * re-validates every pending import of the event once. All or nothing: one
 * bad mapping refuses the whole batch.
 */
export async function saveAliases(
  db: Db,
  input: SaveAliasesInput,
): Promise<ActionResult<{ aliasIds: string[]; imports: RevalidatedImport[] }>> {
  const loaded = await loadEditableEvent(db, input.eventId);
  if (!loaded.ok) return loaded.error;
  if (input.aliases.length === 0) return fail("validation", "Choose at least one name to map.");
  const aliases = input.aliases.map((alias) => ({ ...alias, raw: alias.raw.trim() }));
  if (aliases.some((alias) => alias.raw === "")) return fail("validation", "The raw name is empty.", { raw: ["Required."] });
  const canonicalNames: string[] = [];
  for (const alias of aliases) {
    const canonicalName = await entityCanonicalName(db, input.eventId, alias.entityType, alias.entityId);
    if (canonicalName === null) {
      return fail("not_found", `The person chosen for "${alias.raw}" is not on this event's roster.`);
    }
    canonicalNames.push(canonicalName);
  }

  const aliasIds = await db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const [i, alias] of aliases.entries()) {
      const [row] = await tx
        .insert(nameAliases)
        .values({ eventId: input.eventId, rawText: alias.raw, entityType: alias.entityType, entityId: alias.entityId, source: "manual" })
        .onConflictDoUpdate({
          target: [nameAliases.eventId, nameAliases.entityType, nameAliases.rawText],
          set: { entityId: alias.entityId, source: "manual" },
        })
        .returning();
      await upsertGlobalAlias(tx, {
        rawText: alias.raw,
        entityType: alias.entityType,
        entityId: alias.entityId,
        canonicalName: canonicalNames[i],
        source: "manual",
      });
      await recordAudit(tx, {
        eventId: input.eventId,
        adminId: input.adminId,
        action: "alias.save",
        entityType: "name_alias",
        entityId: row.id,
        after: { raw: alias.raw, entityType: alias.entityType, entityId: alias.entityId },
      });
      ids.push(row.id);
    }
    return ids;
  });
  const revalidated = await revalidatePending(db, input.eventId);
  return ok({ aliasIds, imports: revalidated });
}

/** Maps one raw name to an entity (source manual) and re-validates every pending import of the event. */
export async function saveAlias(
  db: Db,
  input: SaveAliasInput,
): Promise<ActionResult<{ aliasId: string; imports: RevalidatedImport[] }>> {
  const { eventId, adminId, ...alias } = input;
  const result = await saveAliases(db, { eventId, adminId, aliases: [alias] });
  if (!result.ok) return result;
  return ok({ aliasId: result.data.aliasIds[0], imports: result.data.imports });
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

type Counts = { created: number; updated: number };

/** Email is the identity. Existing rows are updated in place; status is never touched here. */
async function applyParticipants(db: Db, eventId: string, rows: ParsedParticipant[]): Promise<Counts> {
  const existing = await db.select().from(participants).where(eq(participants.eventId, eventId));
  const byEmail = new Map(existing.map((row) => [row.email, row]));
  const counts: Counts = { created: 0, updated: 0 };
  for (const row of rows) {
    const current = byEmail.get(row.email);
    if (!current) {
      await db.insert(participants).values({
        eventId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        organization: row.organization,
        title: row.title,
        biztechOptIn: row.biztechOptIn ?? false,
      });
      counts.created += 1;
      continue;
    }
    await db
      .update(participants)
      .set({
        firstName: row.firstName,
        lastName: row.lastName,
        organization: row.organization,
        title: row.title,
        biztechOptIn: row.biztechOptIn ?? current.biztechOptIn,
      })
      .where(eq(participants.id, current.id));
    counts.updated += 1;
  }
  return counts;
}

/** Name is the identity, compared case-insensitively. A changed contact email revokes that link. */
async function applySuppliers(db: Db, eventId: string, rows: ParsedSupplier[]): Promise<Counts> {
  const existing = await db.select().from(suppliers).where(eq(suppliers.eventId, eventId));
  const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row]));
  const counts: Counts = { created: 0, updated: 0 };
  for (const row of rows) {
    const current = byName.get(row.name.toLowerCase());
    const values = {
      type: row.type,
      adminContactName: row.adminContactName,
      adminContactEmail: row.adminContactEmail,
      attendeeContactName: row.attendeeContactName,
      attendeeContactEmail: row.attendeeContactEmail,
    };
    if (!current) {
      await db.insert(suppliers).values({ eventId, name: row.name, ...values });
      counts.created += 1;
      continue;
    }
    await db.update(suppliers).set(values).where(eq(suppliers.id, current.id));
    const changed: ("supplier_admin" | "supplier_attendee")[] = [];
    if (current.adminContactEmail !== row.adminContactEmail) changed.push("supplier_admin");
    if (current.attendeeContactEmail !== row.attendeeContactEmail) changed.push("supplier_attendee");
    if (changed.length) await revokeTokens(db, { eventId, entityId: current.id, contactTypes: changed });
    counts.updated += 1;
  }
  return counts;
}

const RANKING_CHUNK = 500;

async function applyRankings(
  db: Db,
  event: Event,
  importId: string,
  kind: RankingKind,
  analysis: RankingAnalysis,
): Promise<Pick<ApplySummary, "rankingsDeleted" | "rankingsWritten" | "optedIn" | "optedOut">> {
  // Replace: everything written by earlier imports of this kind goes away first.
  const previous = await db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.eventId, event.id), eq(imports.kind, kind), eq(imports.status, "applied"), ne(imports.id, importId)));
  const importIds = [importId, ...previous.map((row) => row.id)];
  const deleted = await db
    .delete(rankings)
    .where(and(eq(rankings.eventId, event.id), inArray(rankings.importId, importIds)))
    .returning({ id: rankings.id });

  const values = analysis.rankings.map((row) => ({
    eventId: event.id,
    rankerType: analysis.rankerType,
    rankerId: row.rankerId,
    targetType: analysis.targetType,
    targetId: row.targetId,
    rank: row.rank,
    isRejection: row.isRejection,
    importId,
  }));
  for (let start = 0; start < values.length; start += RANKING_CHUNK) {
    await db
      .insert(rankings)
      .values(values.slice(start, start + RANKING_CHUNK))
      .onConflictDoUpdate({
        target: [rankings.eventId, rankings.rankerType, rankings.rankerId, rankings.targetType, rankings.targetId],
        set: { rank: sql`excluded.rank`, isRejection: sql`excluded.is_rejection`, importId },
      });
  }

  let optedIn = 0;
  let optedOut = 0;
  // D1: the biztech file is the opt-in signal. Anyone with a choice is in, every other active participant is out.
  if (kind === "buyer_biztech_rankings" && event.settings.biztechOptInRule === "from_biztech_file") {
    const ids = [...analysis.rankersWithChoices];
    if (ids.length > 0) {
      const rows = await db
        .update(participants)
        .set({ biztechOptIn: true })
        .where(and(eq(participants.eventId, event.id), inArray(participants.id, ids)))
        .returning({ id: participants.id });
      optedIn = rows.length;
    }
    const outConditions = [eq(participants.eventId, event.id), eq(participants.status, "active")];
    if (ids.length > 0) outConditions.push(notInArray(participants.id, ids));
    const rows = await db
      .update(participants)
      .set({ biztechOptIn: false })
      .where(and(...outConditions))
      .returning({ id: participants.id });
    optedOut = rows.length;
  }
  return { rankingsDeleted: deleted.length, rankingsWritten: values.length, optedIn, optedOut };
}

/**
 * Names that resolved only through normalisation become auto aliases, so the
 * next file hits them exactly, this year and (through the global copy) later.
 */
async function saveAutoAliases(db: Db, eventId: string, inexact: RankingAnalysis["inexact"]): Promise<number> {
  if (inexact.length === 0) return 0;
  const rows = await db
    .insert(nameAliases)
    .values(inexact.map((entry) => ({ eventId, rawText: entry.raw, entityType: entry.entityType, entityId: entry.entityId, source: "auto" as const })))
    .onConflictDoNothing()
    .returning({ id: nameAliases.id });
  for (const entry of inexact) {
    await upsertGlobalAlias(db, {
      rawText: entry.raw,
      entityType: entry.entityType,
      entityId: entry.entityId,
      canonicalName: entry.canonicalName,
      source: "auto",
    });
  }
  return rows.length;
}

/**
 * Writes the file into the roster or the rankings table, in one transaction.
 * Refuses unless the import is clean: no unknown names, no errors, event editable.
 */
export async function applyImport(
  db: Db,
  input: { importId: string; adminId: string },
): Promise<ActionResult<{ importId: string; summary: ApplySummary }>> {
  const row = await findImport(db, input.importId);
  if (!row) return fail("not_found", "That import no longer exists.");
  const loaded = await loadEditableEvent(db, row.eventId);
  if (!loaded.ok) return loaded.error;
  if (row.status === "applied") return fail("conflict", "This import was already applied.");

  const buffer = await readStoredFile(row);
  if (!buffer) return fail("not_found", "The uploaded file is no longer in storage. Upload it again.");
  const outcome = parseImportFile(row.kind, buffer);
  if (!outcome.ok) return fail("validation", outcome.message);
  const context = await loadContext(db, row.eventId);
  const parsed = outcome.parsed;
  const analysis = parsed.kind === "ranking" && isRankingKind(row.kind) ? analyzeRankings(row.kind, parsed, context) : null;
  const report = analysis ? analysis.report : validateParsed(row.kind, parsed, context);
  const state = importStateFor("validated", report);
  if (state !== "ready") {
    await db.update(imports).set({ validation: report }).where(eq(imports.id, row.id));
    return fail(
      "validation",
      state === "needs_mapping"
        ? "Map every unknown name before applying this file."
        : "Fix the errors in the file and upload it again.",
    );
  }

  const event = loaded.event;
  let summary: ApplySummary;
  try {
    summary = await db.transaction(async (tx) => {
      const result: ApplySummary = {
        kind: row.kind,
        created: 0,
        updated: 0,
        rankingsDeleted: 0,
        rankingsWritten: 0,
        optedIn: 0,
        optedOut: 0,
        aliasesSaved: 0,
        eventAdvanced: false,
      };
      if (parsed.kind === "participants") {
        Object.assign(result, await applyParticipants(tx, event.id, parsed.rows));
      } else if (parsed.kind === "suppliers") {
        Object.assign(result, await applySuppliers(tx, event.id, parsed.rows));
      } else if (analysis && isRankingKind(row.kind)) {
        Object.assign(result, await applyRankings(tx, event, row.id, row.kind, analysis));
        result.aliasesSaved = await saveAutoAliases(tx, event.id, analysis.inexact);
      }
      // Compare-and-set on the status read above: a second apply (or a delete)
      // that got here first makes this match nothing, and the throw rolls back
      // every roster and ranking write above.
      const marked = await tx
        .update(imports)
        .set({ status: "applied", appliedAt: new Date(), validation: report, rowCount: report.counts.rows })
        .where(and(eq(imports.id, row.id), eq(imports.status, row.status)))
        .returning({ id: imports.id });
      if (marked.length === 0) throw new ImportStatusChanged();
      result.eventAdvanced = await advanceStatus(tx, event.id, "draft", "imported");
      await recordAudit(tx, {
        eventId: event.id,
        adminId: input.adminId,
        action: "import.apply",
        entityType: "import",
        entityId: row.id,
        before: { status: row.status },
        after: { status: "applied", ...result },
      });
      return result;
    });
  } catch (error) {
    if (error instanceof ImportStatusChanged) {
      return fail("conflict", "This import was applied or changed by someone else. Reload the page.");
    }
    throw error;
  }
  // A roster change can resolve (or break) names in ranking files waiting to be applied.
  if (!isRankingKind(row.kind)) await revalidatePending(db, event.id);
  return ok({ importId: row.id, summary });
}

/** Thrown inside the apply transaction to roll it back when the import's status moved underneath it. */
class ImportStatusChanged extends Error {}

/** Removes the import and the rankings it wrote, then its stored file. */
export async function deleteImportRecord(
  db: Db,
  input: { importId: string; adminId: string },
): Promise<ActionResult<{ importId: string; rankingsDeleted: number }>> {
  const row = await findImport(db, input.importId);
  if (!row) return fail("not_found", "That import no longer exists.");
  const loaded = await loadEditableEvent(db, row.eventId);
  if (!loaded.ok) return loaded.error;

  const rankingsDeleted = await db.transaction(async (tx) => {
    const deleted = await tx.delete(rankings).where(eq(rankings.importId, row.id)).returning({ id: rankings.id });
    await tx.delete(imports).where(eq(imports.id, row.id));
    await recordAudit(tx, {
      eventId: row.eventId,
      adminId: input.adminId,
      action: "import.delete",
      entityType: "import",
      entityId: row.id,
      before: { kind: row.kind, fileName: row.fileName, status: row.status, rankingsDeleted: deleted.length },
    });
    return deleted.length;
  });
  // After the commit, so a failed delete never leaves a row pointing at no file.
  try {
    await deleteFile(row.fileKey);
  } catch (error) {
    console.warn(`[imports] import ${row.id}: the stored file was not deleted: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ok({ importId: row.id, rankingsDeleted });
}
