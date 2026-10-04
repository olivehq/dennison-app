import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
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
import { getFile, importFileKey, putFile } from "@/lib/storage";
import { recordAudit } from "@/server/audit/audit";
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
  const [participantRows, supplierRows, aliasRows] = await Promise.all([
    db.select().from(participants).where(eq(participants.eventId, eventId)),
    db.select().from(suppliers).where(eq(suppliers.eventId, eventId)),
    db.select().from(nameAliases).where(eq(nameAliases.eventId, eventId)),
  ]);
  return { participants: participantRows, suppliers: supplierRows, aliases: aliasRows };
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

export type SaveAliasInput = {
  eventId: string;
  raw: string;
  entityType: EntityType;
  entityId: string;
  adminId: string;
};

async function entityExists(db: Db, eventId: string, entityType: EntityType, entityId: string): Promise<boolean> {
  const table = entityType === "buyer" ? participants : suppliers;
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, entityId), eq(table.eventId, eventId)))
    .limit(1);
  return row !== undefined;
}

/** Maps a raw name to an entity (source manual) and re-validates every pending import of the event. */
export async function saveAlias(
  db: Db,
  input: SaveAliasInput,
): Promise<ActionResult<{ aliasId: string; imports: { importId: string; kind: ImportKind; state: ImportState }[] }>> {
  const loaded = await loadEditableEvent(db, input.eventId);
  if (!loaded.ok) return loaded.error;
  const raw = input.raw.trim();
  if (raw === "") return fail("validation", "The raw name is empty.", { raw: ["Required."] });
  if (!(await entityExists(db, input.eventId, input.entityType, input.entityId))) {
    return fail("not_found", "That person is not on this event's roster.");
  }

  const alias = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(nameAliases)
      .values({ eventId: input.eventId, rawText: raw, entityType: input.entityType, entityId: input.entityId, source: "manual" })
      .onConflictDoUpdate({
        target: [nameAliases.eventId, nameAliases.entityType, nameAliases.rawText],
        set: { entityId: input.entityId, source: "manual" },
      })
      .returning();
    await recordAudit(tx, {
      eventId: input.eventId,
      adminId: input.adminId,
      action: "alias.save",
      entityType: "name_alias",
      entityId: row.id,
      after: { raw, entityType: input.entityType, entityId: input.entityId },
    });
    return row;
  });
  const revalidated = await revalidatePending(db, input.eventId);
  return ok({ aliasId: alias.id, imports: revalidated });
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

/** Names that resolved only through normalisation become auto aliases, so the next file hits them exactly. */
async function saveAutoAliases(db: Db, eventId: string, inexact: RankingAnalysis["inexact"]): Promise<number> {
  if (inexact.length === 0) return 0;
  const rows = await db
    .insert(nameAliases)
    .values(inexact.map((entry) => ({ eventId, rawText: entry.raw, entityType: entry.entityType, entityId: entry.entityId, source: "auto" as const })))
    .onConflictDoNothing()
    .returning({ id: nameAliases.id });
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
  const summary = await db.transaction(async (tx) => {
    const result: ApplySummary = {
      kind: row.kind,
      created: 0,
      updated: 0,
      rankingsDeleted: 0,
      rankingsWritten: 0,
      optedIn: 0,
      optedOut: 0,
      aliasesSaved: 0,
    };
    if (parsed.kind === "participants") {
      Object.assign(result, await applyParticipants(tx, event.id, parsed.rows));
    } else if (parsed.kind === "suppliers") {
      Object.assign(result, await applySuppliers(tx, event.id, parsed.rows));
    } else if (analysis && isRankingKind(row.kind)) {
      Object.assign(result, await applyRankings(tx, event, row.id, row.kind, analysis));
      result.aliasesSaved = await saveAutoAliases(tx, event.id, analysis.inexact);
    }
    await tx
      .update(imports)
      .set({ status: "applied", appliedAt: new Date(), validation: report, rowCount: report.counts.rows })
      .where(eq(imports.id, row.id));
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
  return ok({ importId: row.id, summary });
}

/** Removes the import and the rankings it wrote. The stored file is left in place. */
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
  return ok({ importId: row.id, rankingsDeleted });
}
