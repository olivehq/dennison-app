import type {
  EntityType,
  ImportFormat,
  ImportKind,
  ImportState,
  ImportValidationReport,
  RankingKind,
  UnknownName,
} from "@/lib/schemas/import";
import { displayNameFor, fullNameFor } from "@/server/roster/display-name";
import { resolveNames, type AliasRow, type ResolvableEntity } from "./resolve";
import type {
  ParsedFile,
  ParsedParticipant,
  ParsedRankingListRow,
  ParsedRankingMatrixRow,
  ParsedSupplier,
  RowMessage,
} from "./parsers/types";

export type ContextParticipant = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  organization: string | null;
  title: string | null;
  displayName: string | null;
  status: "active" | "withdrawn";
};

export type ContextSupplier = {
  id: string;
  name: string;
  type: "business" | "hotel";
  adminContactEmail: string | null;
  attendeeContactEmail: string | null;
  status: "active" | "withdrawn";
};

export type ContextAlias = { rawText: string; entityType: EntityType; entityId: string };

/** The event's current roster and alias table, loaded once per validation. */
export type ValidationContext = {
  participants: ContextParticipant[];
  suppliers: ContextSupplier[];
  aliases: ContextAlias[];
};

export type RankingRow = {
  rankerId: string;
  targetId: string;
  rank: number | null;
  isRejection: boolean;
};

export type RankingAnalysis = {
  rankerType: EntityType;
  targetType: EntityType;
  rankings: RankingRow[];
  /** Rankers with at least one ranked choice. Drives biztech opt-in (D1). */
  rankersWithChoices: Set<string>;
  /** Names that resolved only through normalisation; saved as auto aliases on apply. */
  inexact: { raw: string; entityType: EntityType; entityId: string }[];
  report: ImportValidationReport;
};

type Entities = ResolvableEntity & { emails: string[]; active: boolean };

function participantEntities(participants: ContextParticipant[]): Entities[] {
  return participants.map((person) => {
    const full = fullNameFor(person);
    const names = new Set([full, displayNameFor(person)]);
    if (person.organization && person.title) names.add(`${person.organization} - ${person.title}`);
    if (person.displayName) names.add(person.displayName);
    const label = person.organization ? `${full} (${person.organization})` : full;
    return {
      id: person.id,
      label,
      names: [...names].filter((name) => name !== ""),
      emails: [person.email],
      active: person.status === "active",
    };
  });
}

function supplierEntities(suppliers: ContextSupplier[]): Entities[] {
  return suppliers.map((supplier) => ({
    id: supplier.id,
    label: supplier.name,
    names: [supplier.name],
    emails: [supplier.adminContactEmail, supplier.attendeeContactEmail].filter(
      (email): email is string => email !== null,
    ),
    active: supplier.status === "active",
  }));
}

function emptyReport(format: ImportFormat | null, rows: number): ImportValidationReport {
  return {
    format,
    counts: {
      rows,
      rankers: 0,
      rankings: 0,
      resolvedNames: 0,
      unknownNames: 0,
      errors: 0,
      warnings: 0,
    },
    errors: [],
    warnings: [],
    unresolvedNames: [],
    unknownNames: [],
    duplicateEmails: [],
    duplicateNames: [],
    missingEmails: [],
    rowsWithZeroRankings: [],
    rankedByNobody: [],
    rankedNobody: [],
  };
}

function finalise(report: ImportValidationReport): ImportValidationReport {
  report.unresolvedNames = report.unknownNames.map((name) => name.raw);
  report.counts.unknownNames = report.unknownNames.length;
  report.counts.errors = report.errors.length;
  report.counts.warnings = report.warnings.length;
  return report;
}

function stripCodes(messages: RowMessage[]): { row: number | null; message: string }[] {
  return messages.map(({ row, message }) => ({ row, message }));
}

function duplicates(values: { row: number; value: string }[]): { value: string; rows: number[] }[] {
  const rows = new Map<string, number[]>();
  for (const entry of values) {
    const key = entry.value.toLowerCase();
    rows.set(key, [...(rows.get(key) ?? []), entry.row]);
  }
  return [...rows.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([value, list]) => ({ value, rows: list }));
}

// ---------------------------------------------------------------------------
// Roster templates
// ---------------------------------------------------------------------------

export function validateParticipants(
  rows: ParsedParticipant[],
  parseErrors: RowMessage[],
  context: ValidationContext,
): ImportValidationReport {
  const report = emptyReport("template", rows.length + parseErrors.filter((e) => e.row !== null).length);
  report.errors.push(...stripCodes(parseErrors));
  report.missingEmails = parseErrors
    .filter((error) => error.code === "missing_email" && error.row !== null)
    .map((error) => error.row as number);

  report.duplicateEmails = duplicates(rows.map((row) => ({ row: row.row, value: row.email })));
  for (const duplicate of report.duplicateEmails) {
    report.errors.push({
      row: duplicate.rows[0],
      message: `${duplicate.value} appears on rows ${duplicate.rows.join(", ")}. Keep one.`,
    });
  }

  const byEmail = new Map(context.participants.map((person) => [person.email, person]));
  const inFile = new Set<string>();
  for (const row of rows) {
    inFile.add(row.email);
    const existing = byEmail.get(row.email);
    if (existing?.status === "withdrawn") {
      report.warnings.push({
        row: row.row,
        message: `${row.email} is withdrawn and stays withdrawn. Restore them from the roster if they are back.`,
      });
    }
  }
  const absent = context.participants.filter((person) => !inFile.has(person.email));
  if (absent.length > 0) {
    report.warnings.push({
      row: null,
      message: `${absent.length} participant${absent.length === 1 ? "" : "s"} on the roster ${
        absent.length === 1 ? "is" : "are"
      } not in this file and will be kept as is.`,
    });
  }
  return finalise(report);
}

export function validateSuppliers(
  rows: ParsedSupplier[],
  parseErrors: RowMessage[],
  context: ValidationContext,
): ImportValidationReport {
  const report = emptyReport("template", rows.length + parseErrors.filter((e) => e.row !== null).length);
  report.errors.push(...stripCodes(parseErrors));

  report.duplicateNames = duplicates(rows.map((row) => ({ row: row.row, value: row.name })));
  for (const duplicate of report.duplicateNames) {
    report.errors.push({
      row: duplicate.rows[0],
      message: `"${duplicate.value}" appears on rows ${duplicate.rows.join(", ")}. Keep one.`,
    });
  }

  const byName = new Map(context.suppliers.map((supplier) => [supplier.name.toLowerCase(), supplier]));
  const inFile = new Set<string>();
  for (const row of rows) {
    inFile.add(row.name.toLowerCase());
    const existing = byName.get(row.name.toLowerCase());
    if (existing && existing.type !== row.type) {
      report.warnings.push({
        row: row.row,
        message: `${row.name} changes from ${existing.type} to ${row.type}.`,
      });
    }
    if (existing?.status === "withdrawn") {
      report.warnings.push({
        row: row.row,
        message: `${row.name} is withdrawn and stays withdrawn. Restore them from the roster if they are back.`,
      });
    }
    if (!row.adminContactEmail && !row.attendeeContactEmail) {
      report.warnings.push({
        row: row.row,
        message: `${row.name} has no contact email, so no schedule link can be sent.`,
      });
    }
  }
  const absent = context.suppliers.filter((supplier) => !inFile.has(supplier.name.toLowerCase()));
  if (absent.length > 0) {
    report.warnings.push({
      row: null,
      message: `${absent.length} supplier${absent.length === 1 ? "" : "s"} on the roster ${
        absent.length === 1 ? "is" : "are"
      } not in this file and will be kept as is.`,
    });
  }
  return finalise(report);
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export function rankingRoles(kind: RankingKind): { rankerType: EntityType; targetType: EntityType } {
  return kind === "supplier_rankings"
    ? { rankerType: "supplier", targetType: "buyer" }
    : { rankerType: "buyer", targetType: "supplier" };
}

type NamedRow = {
  row: number;
  rankerName: string;
  rankerEmail: string | null;
  /** Target name with its rank, or a rejection. Unranked blanks are already dropped. */
  choices: { targetName: string; rank: number | null; isRejection: boolean }[];
};

function toNamedRows(parsed: ParsedFile & { kind: "ranking" }): NamedRow[] {
  if (parsed.format === "list") {
    return parsed.rows.map((row: ParsedRankingListRow) => ({
      row: row.row,
      rankerName: row.rankerName,
      rankerEmail: row.rankerEmail,
      choices: row.choices.map((choice) => ({ ...choice, isRejection: false })),
    }));
  }
  return parsed.rows.map((row: ParsedRankingMatrixRow) => ({
    row: row.row,
    rankerName: row.rankerName,
    rankerEmail: null,
    choices: row.cells
      .filter((cell) => cell.rank !== null || cell.isRejection)
      .map((cell) => ({ targetName: cell.targetName, rank: cell.rank, isRejection: cell.isRejection })),
  }));
}

function aliasesFor(context: ValidationContext, entityType: EntityType): AliasRow[] {
  return context.aliases
    .filter((alias) => alias.entityType === entityType)
    .map(({ rawText, entityId }) => ({ rawText, entityId }));
}

function unknownNameEntries(
  unresolved: { raw: string; suggestions: UnknownName["suggestions"] }[],
  entityType: EntityType,
  role: UnknownName["role"],
  rowsByRaw: Map<string, number[]>,
): UnknownName[] {
  return unresolved.map((entry) => ({
    raw: entry.raw,
    entityType,
    role,
    rows: rowsByRaw.get(entry.raw) ?? [],
    suggestions: entry.suggestions,
  }));
}

/**
 * Resolves every name in a ranking file against the roster and produces both
 * the rows to write and the report. Rejections (`isRejection`) are preserved
 * from the matrix N/A; list files never produce them (D2).
 */
export function analyzeRankings(
  kind: RankingKind,
  parsed: ParsedFile & { kind: "ranking" },
  context: ValidationContext,
): RankingAnalysis {
  const { rankerType, targetType } = rankingRoles(kind);
  const participants = participantEntities(context.participants);
  const suppliers = supplierEntities(context.suppliers);
  const rankers = rankerType === "buyer" ? participants : suppliers;
  const targets = targetType === "buyer" ? participants : suppliers;
  const rows = toNamedRows(parsed);
  const report = emptyReport(parsed.format, rows.length + parsed.errors.filter((e) => e.row !== null).length);
  report.errors.push(...stripCodes(parsed.errors));
  const inexact: RankingAnalysis["inexact"] = [];

  // Rankers: email first when the file has one, then the name.
  const byEmail = new Map<string, string>();
  for (const entity of rankers) for (const email of entity.emails) byEmail.set(email, entity.id);
  const rankerNames = rows.filter((row) => !(row.rankerEmail && byEmail.has(row.rankerEmail)));
  const rankerResolution = resolveNames(
    rankerNames.map((row) => row.rankerName),
    rankers,
    aliasesFor(context, rankerType),
  );
  for (const [raw, entityId] of rankerResolution.inexact) inexact.push({ raw, entityType: rankerType, entityId });

  const rankerIdByRow = new Map<number, string>();
  const unknownRankerRows = new Map<string, number[]>();
  for (const row of rows) {
    const id =
      (row.rankerEmail ? byEmail.get(row.rankerEmail) : undefined) ??
      rankerResolution.resolved.get(row.rankerName.trim());
    if (id) {
      rankerIdByRow.set(row.row, id);
      continue;
    }
    if (row.choices.length === 0) {
      // Nobody to match and nothing to map: a test row or a blank line. Skip with a note.
      report.warnings.push({
        row: row.row,
        message: `"${row.rankerName}" is not on the roster and ranked nobody. Skipped.`,
      });
      continue;
    }
    const raw = row.rankerName.trim();
    unknownRankerRows.set(raw, [...(unknownRankerRows.get(raw) ?? []), row.row]);
  }
  report.unknownNames.push(
    ...unknownNameEntries(
      rankerResolution.unresolved.filter((entry) => unknownRankerRows.has(entry.raw)),
      rankerType,
      "ranker",
      unknownRankerRows,
    ),
  );

  // Two rows for one person is ambiguous; the admin must fix the file.
  const rowsByRanker = new Map<string, number[]>();
  for (const [row, id] of rankerIdByRow) rowsByRanker.set(id, [...(rowsByRanker.get(id) ?? []), row]);
  const labelOf = new Map([...rankers, ...targets].map((entity) => [entity.id, entity.label]));
  for (const [id, rowList] of rowsByRanker) {
    if (rowList.length > 1) {
      report.duplicateNames.push({ value: labelOf.get(id) ?? id, rows: rowList });
      report.errors.push({
        row: rowList[0],
        message: `${labelOf.get(id) ?? id} appears on rows ${rowList.join(", ")}. Keep one.`,
      });
    }
  }

  // Targets.
  const targetRows = new Map<string, number[]>();
  for (const row of rows) {
    for (const choice of row.choices) {
      const raw = choice.targetName.trim();
      targetRows.set(raw, [...(targetRows.get(raw) ?? []), row.row]);
    }
  }
  const targetResolution = resolveNames(targetRows.keys(), targets, aliasesFor(context, targetType));
  for (const [raw, entityId] of targetResolution.inexact) inexact.push({ raw, entityType: targetType, entityId });
  report.unknownNames.push(
    ...unknownNameEntries(targetResolution.unresolved, targetType, "target", targetRows),
  );

  // Rows to write.
  const rankings: RankingRow[] = [];
  const rankersWithChoices = new Set<string>();
  const rankedTargets = new Set<string>();
  const supplierTypeById = new Map(context.suppliers.map((supplier) => [supplier.id, supplier.type]));
  const expectedType = kind === "buyer_biztech_rankings" ? "business" : kind === "buyer_hotel_rankings" ? "hotel" : null;
  for (const row of rows) {
    const rankerId = rankerIdByRow.get(row.row);
    if (!rankerId) continue;
    if (row.choices.length === 0) {
      report.rowsWithZeroRankings.push({ row: row.row, name: labelOf.get(rankerId) ?? row.rankerName });
    }
    const seenTargets = new Set<string>();
    for (const choice of row.choices) {
      const targetId = targetResolution.resolved.get(choice.targetName.trim());
      if (!targetId) continue;
      if (seenTargets.has(targetId)) {
        report.warnings.push({
          row: row.row,
          message: `${labelOf.get(rankerId)} lists ${labelOf.get(targetId)} more than once. The first rank is kept.`,
        });
        continue;
      }
      seenTargets.add(targetId);
      if (expectedType && supplierTypeById.get(targetId) !== expectedType) {
        report.warnings.push({
          row: row.row,
          message: `${labelOf.get(targetId)} is a ${supplierTypeById.get(targetId)} supplier but appears in the ${expectedType} file.`,
        });
      }
      rankings.push({ rankerId, targetId, rank: choice.rank, isRejection: choice.isRejection });
      if (choice.rank !== null) {
        rankersWithChoices.add(rankerId);
        rankedTargets.add(targetId);
      }
    }
  }

  for (const entity of rankers) {
    if (entity.active && !rankersWithChoices.has(entity.id)) {
      report.rankedNobody.push({ entityId: entity.id, name: entity.label });
    }
  }
  for (const entity of targets) {
    if (entity.active && !rankedTargets.has(entity.id)) {
      report.rankedByNobody.push({ entityId: entity.id, name: entity.label });
    }
  }
  if (report.rankedNobody.length > 0) {
    report.warnings.push({
      row: null,
      message: `${report.rankedNobody.length} active ${rankerType === "buyer" ? "participant" : "supplier"}${
        report.rankedNobody.length === 1 ? "" : "s"
      } ranked nobody in this file.`,
    });
  }
  if (report.rankedByNobody.length > 0) {
    report.warnings.push({
      row: null,
      message: `${report.rankedByNobody.length} active ${targetType === "buyer" ? "participant" : "supplier"}${
        report.rankedByNobody.length === 1 ? "" : "s"
      } ${report.rankedByNobody.length === 1 ? "was" : "were"} ranked by nobody.`,
    });
  }

  report.counts.rankers = rowsByRanker.size;
  report.counts.rankings = rankings.length;
  report.counts.resolvedNames = rankerResolution.resolved.size + targetResolution.resolved.size;
  return { rankerType, targetType, rankings, rankersWithChoices, inexact, report: finalise(report) };
}

/** Report for any kind. Ranking kinds go through `analyzeRankings`; this is the shared entry point. */
export function validateParsed(
  kind: ImportKind,
  parsed: ParsedFile,
  context: ValidationContext,
): ImportValidationReport {
  if (parsed.kind === "participants") return validateParticipants(parsed.rows, parsed.errors, context);
  if (parsed.kind === "suppliers") return validateSuppliers(parsed.rows, parsed.errors, context);
  if (kind === "participants" || kind === "suppliers") {
    throw new Error(`Parsed a ranking file for kind ${kind}.`);
  }
  return analyzeRankings(kind, parsed, context).report;
}

/** A parse failure stored on a `failed` import. */
export function failedReport(message: string): ImportValidationReport {
  const report = emptyReport(null, 0);
  report.errors.push({ row: null, message });
  return finalise(report);
}

/** Collapses the database status and the report into the state the UI shows. */
export function importStateFor(
  status: "uploaded" | "validated" | "applied" | "failed",
  report: ImportValidationReport | null,
): ImportState {
  if (status === "failed") return "failed";
  if (status === "applied") return "applied";
  if (!report) return "failed";
  if (report.unknownNames.length > 0) return "needs_mapping";
  if (report.errors.length > 0) return "needs_fixes";
  return "ready";
}
