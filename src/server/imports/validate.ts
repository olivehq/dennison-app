import { compareNames } from "@/lib/names";
import {
  IMPORT_KIND_LABELS,
  nameSample,
  type AliasedName,
  type EntityType,
  type ImportFormat,
  type ImportKind,
  type ImportState,
  type ImportValidationReport,
  type RankingKind,
  type RosterChanges,
  type UnknownName,
} from "@/lib/schemas/import";
import { displayNameFor, fullNameFor } from "@/server/roster/display-name";
import { EXAMPLE_PARTICIPANT_EMAIL, EXAMPLE_SUPPLIER_NAME } from "./templates";
import {
  resolveNames,
  type AliasRow,
  type GlobalAliasRow,
  type ResolvableEntity,
  type Resolution,
  type Unresolved,
} from "./resolve";
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
  /** Compared with the file to show what an apply changes. */
  biztechOptIn?: boolean;
};

export type ContextSupplier = {
  id: string;
  name: string;
  type: "business" | "hotel";
  adminContactName?: string | null;
  adminContactEmail: string | null;
  attendeeContactName?: string | null;
  attendeeContactEmail: string | null;
  status: "active" | "withdrawn";
};

export type ContextAlias = { rawText: string; entityType: EntityType; entityId: string };

/** A cross-year alias (`event_id` null, D76). */
export type ContextGlobalAlias = { rawText: string; entityType: EntityType; canonicalName: string };

/** The event's current roster and alias table, loaded once per validation. */
export type ValidationContext = {
  participants: ContextParticipant[];
  suppliers: ContextSupplier[];
  aliases: ContextAlias[];
  /** Cross-year aliases, matched to this roster by canonical name. */
  globalAliases?: ContextGlobalAlias[];
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
  inexact: { raw: string; entityType: EntityType; entityId: string; canonicalName: string }[];
  report: ImportValidationReport;
};

type Entities = ResolvableEntity & {
  emails: string[];
  active: boolean;
  /** Enough to tell two people with one name apart: name, organization, title, email. */
  detail: string;
};

function participantEntities(participants: ContextParticipant[]): Entities[] {
  return participants.map((person) => {
    const full = fullNameFor(person);
    const names = new Set([full, displayNameFor(person)]);
    if (person.organization && person.title) names.add(`${person.organization} - ${person.title}`);
    if (person.displayName) names.add(person.displayName);
    const label = person.organization ? `${full} (${person.organization})` : full;
    const facts = [person.organization, person.title, person.email].filter((fact): fact is string => Boolean(fact));
    return {
      id: person.id,
      label,
      canonicalName: full,
      names: [...names].filter((name) => name !== ""),
      emails: [person.email],
      organization: person.organization,
      active: person.status === "active",
      detail: `${full} (${facts.join(", ")})`,
    };
  });
}

function supplierEntities(suppliers: ContextSupplier[]): Entities[] {
  return suppliers.map((supplier) => ({
    id: supplier.id,
    label: supplier.name,
    canonicalName: supplier.name,
    names: [supplier.name],
    emails: [supplier.adminContactEmail, supplier.attendeeContactEmail].filter(
      (email): email is string => email !== null,
    ),
    active: supplier.status === "active",
    detail: supplier.name,
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
    rankersInFile: [],
  };
}

function finalise(report: ImportValidationReport): ImportValidationReport {
  report.unresolvedNames = report.unknownNames.map((name) => name.raw);
  report.counts.unknownNames = report.unknownNames.length;
  report.counts.errors = report.errors.length;
  report.counts.warnings = report.warnings.length;
  report.errors = byRow(report.errors);
  report.warnings = byRow(report.warnings);
  return report;
}

const EXAMPLE_ROW_MESSAGE = "This is the template's example row. Delete it, then upload the file again.";

/** Messages in row order, the ones about the whole file last. The sort is stable, so ties keep the order they were found in. */
function byRow<T extends { row: number | null }>(messages: T[]): T[] {
  return [...messages].sort((a, b) => (a.row ?? Infinity) - (b.row ?? Infinity));
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

/** How many names each changed field lists before apply. */
const CHANGE_SAMPLE = 3;
/** How many people the "not in this file" warning names. */
const MISSING_SAMPLE = 5;

type RowChange = { name: string; fields: string[] };

/** Field-by-field changes for people already on the roster, and who isn't in the file. */
function rosterChanges(changes: RowChange[], missing: string[], cleared: RowChange[]): RosterChanges {
  const byField = new Map<string, string[]>();
  for (const change of changes) {
    for (const field of change.fields) byField.set(field, [...(byField.get(field) ?? []), change.name]);
  }
  return {
    updated: changes.filter((change) => change.fields.length > 0).length,
    unchanged: changes.filter((change) => change.fields.length === 0).length,
    fields: [...byField].map(([field, names]) => ({
      field,
      count: names.length,
      names: [...names].sort(compareNames).slice(0, CHANGE_SAMPLE),
    })),
    cleared,
    missing: [...missing].sort(compareNames),
  };
}

function missingWarning(missing: string[], one: string, many: string): { row: null; message: string } {
  return {
    row: null,
    message: `${missing.length} ${missing.length === 1 ? `${one} on the roster is` : `${many} on the roster are`} not in this file and will be kept as is: ${nameSample(
      [...missing].sort(compareNames).slice(0, MISSING_SAMPLE),
      missing.length,
    )}.`,
  };
}

/** The labels of the fields that differ, in the given order. Blank and null are the same. */
function changedFields(pairs: [label: string, before: unknown, after: unknown][]): string[] {
  return pairs.filter(([, before, after]) => (before ?? null) !== (after ?? null)).map(([label]) => label);
}

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

  for (const row of rows) {
    if (row.email === EXAMPLE_PARTICIPANT_EMAIL) {
      report.errors.push({ row: row.row, message: EXAMPLE_ROW_MESSAGE });
    }
  }

  const byEmail = new Map(context.participants.map((person) => [person.email, person]));
  const inFile = new Set<string>();
  const changes: RowChange[] = [];
  const cleared: RowChange[] = [];
  for (const row of rows) {
    inFile.add(row.email);
    const existing = byEmail.get(row.email);
    if (!existing) continue;
    if (existing.status === "withdrawn") {
      report.warnings.push({
        row: row.row,
        message: `${row.email} is withdrawn and stays withdrawn. Restore them from the roster if they are back.`,
      });
    }
    const name = fullNameFor(existing);
    changes.push({
      name,
      fields: changedFields([
        ["First name", existing.firstName, row.firstName],
        ["Last name", existing.lastName, row.lastName],
        ["Organization", existing.organization, row.organization],
        ["Title", existing.title, row.title],
        // A blank cell keeps the current opt-in, and older contexts don't carry it.
        ["Biztech opt-in", existing.biztechOptIn, row.biztechOptIn ?? existing.biztechOptIn],
      ]),
    });
    // Someone shown as "Organization - Title" who would lose either part.
    if (existing.organization && existing.title) {
      const lost = [row.organization ? null : "organization", row.title ? null : "title"].filter((field) => field !== null);
      if (lost.length > 0) {
        cleared.push({ name, fields: lost });
        report.warnings.push({
          row: row.row,
          message: `${name} has an organization and a title on the roster. Applying this file clears their ${lost.join(" and ")}.`,
        });
      }
    }
  }
  const absent = context.participants.filter((person) => !inFile.has(person.email)).map((person) => fullNameFor(person));
  if (absent.length > 0) report.warnings.push(missingWarning(absent, "participant", "participants"));
  report.rosterChanges = rosterChanges(changes, absent, cleared);
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

  for (const row of rows) {
    if (row.name.toLowerCase() === EXAMPLE_SUPPLIER_NAME.toLowerCase()) {
      report.errors.push({ row: row.row, message: EXAMPLE_ROW_MESSAGE });
    }
  }

  const byName = new Map(context.suppliers.map((supplier) => [supplier.name.toLowerCase(), supplier]));
  const inFile = new Set<string>();
  const changes: RowChange[] = [];
  for (const row of rows) {
    inFile.add(row.name.toLowerCase());
    const existing = byName.get(row.name.toLowerCase());
    if (existing) {
      changes.push({
        name: existing.name,
        fields: changedFields([
          ["Type", existing.type, row.type],
          // Older contexts don't carry contact names; only compare what they have.
          ["Admin contact name", existing.adminContactName, existing.adminContactName === undefined ? undefined : row.adminContactName],
          ["Admin contact email", existing.adminContactEmail, row.adminContactEmail],
          ["Attendee contact name", existing.attendeeContactName, existing.attendeeContactName === undefined ? undefined : row.attendeeContactName],
          ["Attendee contact email", existing.attendeeContactEmail, row.attendeeContactEmail],
        ]),
      });
    }
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
  const absent = context.suppliers.filter((supplier) => !inFile.has(supplier.name.toLowerCase())).map((supplier) => supplier.name);
  if (absent.length > 0) report.warnings.push(missingWarning(absent, "supplier", "suppliers"));
  report.rosterChanges = rosterChanges(changes, absent, []);
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

function globalAliasesFor(context: ValidationContext, entityType: EntityType): GlobalAliasRow[] {
  return (context.globalAliases ?? [])
    .filter((alias) => alias.entityType === entityType)
    .map(({ rawText, canonicalName }) => ({ rawText, canonicalName }));
}

function unknownNameEntries(
  unresolved: Unresolved[],
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
    ...(entry.ambiguous ? { ambiguous: true } : {}),
  }));
}

/**
 * A saved mapping for a text several people share (a company, a common name)
 * sends every row with that text to one person. Not silent: one warning per
 * text, naming who it goes to and how to point a row at someone else.
 */
function aliasedAmbiguousWarnings(
  resolution: Resolution,
  rowsByRaw: Map<string, number[]>,
  detailOf: Map<string, string>,
  noun: string,
): { row: number | null; message: string }[] {
  return [...resolution.aliasedAmbiguous].map(([raw, candidates]) => {
    const rows = rowsByRaw.get(raw) ?? [];
    const target = resolution.resolved.get(raw)!;
    // With several rows the message names them all, so it carries no single row for the page to prefix.
    return {
      row: rows.length === 1 ? rows[0] : null,
      message: `${rows.length > 1 ? `Rows ${rows.join(", ")}: ` : ""}"${raw}" matches ${candidates.length} ${noun}s. A saved mapping sends it to ${
        detailOf.get(target) ?? target
      }. If a row means someone else, put their email in the file instead.`,
    };
  });
}

/** The names a resolution settled through a saved alias, for the report. */
function aliasedNameEntries(
  resolution: Resolution,
  entityType: EntityType,
  rowsByRaw: Map<string, number[]>,
  labelOf: Map<string, string>,
): AliasedName[] {
  return [...resolution.viaAlias].map(([raw, scope]) => {
    const entityId = resolution.resolved.get(raw)!;
    return { raw, entityType, name: labelOf.get(entityId) ?? entityId, scope, rows: rowsByRaw.get(raw) ?? [] };
  });
}

/** A rank as the file shows it: the CHOICE column number, or N/A in a matrix. */
function choiceLabel(rank: number | null): string {
  return rank === null ? "N/A" : `choice ${rank}`;
}

/** What a ranking file holds, for "their <kind> rankings will be cleared". */
const RANKINGS_OF_KIND: Record<RankingKind, string> = {
  buyer_biztech_rankings: "biztech rankings",
  buyer_hotel_rankings: "hotel rankings",
  supplier_rankings: "rankings of participants",
};

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
  const fileRows = toNamedRows(parsed);
  const report = emptyReport(parsed.format, fileRows.length + parsed.errors.filter((e) => e.row !== null).length);
  report.errors.push(...stripCodes(parsed.errors));
  // The template's example row is refused and left out of the rest of the check, so its
  // made-up names don't also show up as names to map.
  const rows = fileRows.filter((row) => {
    const isExample =
      row.rankerEmail === EXAMPLE_PARTICIPANT_EMAIL || row.rankerName.trim().toLowerCase() === EXAMPLE_SUPPLIER_NAME.toLowerCase();
    if (isExample) report.errors.push({ row: row.row, message: EXAMPLE_ROW_MESSAGE });
    return !isExample;
  });
  const inexact: RankingAnalysis["inexact"] = [];

  // Rankers: email first when the file has one, then the name.
  const byEmail = new Map<string, string>();
  for (const entity of rankers) for (const email of entity.emails) byEmail.set(email, entity.id);
  const rankerNames = rows.filter((row) => !(row.rankerEmail && byEmail.has(row.rankerEmail)));
  const rankerResolution = resolveNames(
    rankerNames.map((row) => row.rankerName),
    rankers,
    aliasesFor(context, rankerType),
    globalAliasesFor(context, rankerType),
  );
  const canonicalOf = new Map(
    [...rankers, ...targets].map((entity) => [entity.id, entity.canonicalName ?? entity.label]),
  );
  for (const [raw, entityId] of rankerResolution.inexact) {
    inexact.push({ raw, entityType: rankerType, entityId, canonicalName: canonicalOf.get(entityId) ?? raw });
  }

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
  // Suppliers name buyers by email or company as well as by name: an email
  // decides, then this event's alias, then a company only one buyer has.
  const targetResolution = resolveNames(
    targetRows.keys(),
    targets,
    aliasesFor(context, targetType),
    globalAliasesFor(context, targetType),
    targetType === "buyer" ? { byEmail: true, byOrganization: true } : {},
  );
  for (const [raw, entityId] of targetResolution.inexact) {
    inexact.push({ raw, entityType: targetType, entityId, canonicalName: canonicalOf.get(entityId) ?? raw });
  }
  report.unknownNames.push(
    ...unknownNameEntries(targetResolution.unresolved, targetType, "target", targetRows),
  );
  const detailOf = new Map([...rankers, ...targets].map((entity) => [entity.id, entity.detail]));
  const rankerRows = new Map<string, number[]>();
  for (const row of rankerNames) {
    const raw = row.rankerName.trim();
    rankerRows.set(raw, [...(rankerRows.get(raw) ?? []), row.row]);
  }
  const noun = (type: EntityType) => (type === "buyer" ? "participant" : "supplier");
  report.warnings.push(
    ...aliasedAmbiguousWarnings(rankerResolution, rankerRows, detailOf, noun(rankerType)),
    ...aliasedAmbiguousWarnings(targetResolution, targetRows, detailOf, noun(targetType)),
  );
  report.aliasedNames = [
    ...aliasedNameEntries(rankerResolution, rankerType, rankerRows, labelOf),
    ...aliasedNameEntries(targetResolution, targetType, targetRows, labelOf),
  ].sort((a, b) => compareNames(a.raw, b.raw));

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
      report.warnings.push({
        row: row.row,
        message: `${labelOf.get(rankerId) ?? row.rankerName} has no choices in this file; their ${RANKINGS_OF_KIND[kind]} will be cleared.`,
      });
    }
    // Every choice that resolved to each target, in file order. One warning per
    // target listed twice, quoting the text in the file, since two spellings
    // (or a saved mapping) can land on one supplier.
    const choicesOf = new Map<string, { raw: string; rank: number | null }[]>();
    for (const choice of row.choices) {
      const raw = choice.targetName.trim();
      const targetId = targetResolution.resolved.get(raw);
      if (!targetId) continue;
      const earlier = choicesOf.get(targetId);
      choicesOf.set(targetId, [...(earlier ?? []), { raw, rank: choice.rank }]);
      if (earlier) continue;
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
    for (const [targetId, listed] of choicesOf) {
      if (listed.length < 2) continue;
      const spellings = listed.map((entry) => `"${entry.raw}" (${choiceLabel(entry.rank)})`).join(", ");
      report.warnings.push({
        row: row.row,
        message: `${labelOf.get(rankerId)} lists ${labelOf.get(targetId)} ${listed.length} times: ${spellings}. Only ${choiceLabel(listed[0].rank)} is kept.`,
      });
    }
  }

  // Every choice resolved to suppliers of the other type: the file is on the wrong card.
  // At least three, so one or two names resolved so far can't send a right file away.
  if (expectedType && rankings.length >= 3 && rankings.every((ranking) => supplierTypeById.get(ranking.targetId) !== expectedType)) {
    const otherKind: RankingKind = expectedType === "hotel" ? "buyer_biztech_rankings" : "buyer_hotel_rankings";
    report.errors.push({
      row: null,
      message: `Every choice in this file is a ${expectedType === "hotel" ? "business" : "hotel"} supplier. This looks like a ${IMPORT_KIND_LABELS[otherKind].toLowerCase()} file. Upload it on the ${IMPORT_KIND_LABELS[otherKind]} card.`,
    });
  }

  // A file may hold only some rankers (apply replaces per ranker), so these
  // are information, worded for a partial file.
  const activeRankers = rankers.filter((entity) => entity.active);
  for (const entity of activeRankers) {
    if (!rankersWithChoices.has(entity.id)) report.rankedNobody.push({ entityId: entity.id, name: entity.label });
  }
  // Buyer files only count suppliers of the file's type: a hotel file never ranks business suppliers.
  const activeTargets = targets.filter(
    (entity) => entity.active && (!expectedType || supplierTypeById.get(entity.id) === expectedType),
  );
  for (const entity of activeTargets) {
    if (!rankedTargets.has(entity.id)) report.rankedByNobody.push({ entityId: entity.id, name: entity.label });
  }
  const rankerNoun = `active ${noun(rankerType)}${activeRankers.length === 1 ? "" : "s"}`;
  if (report.rankedNobody.length > 0) {
    report.warnings.push({
      row: null,
      message: `This file has rankings for ${activeRankers.length - report.rankedNobody.length} of ${activeRankers.length} ${rankerNoun}. Everyone else keeps their current rankings.`,
    });
  }
  if (report.rankedByNobody.length > 0) {
    const targetNoun = `active ${expectedType ? `${expectedType} ` : ""}${noun(targetType)}${activeTargets.length === 1 ? "" : "s"}`;
    report.warnings.push({
      row: null,
      message: `Nobody in this file chose ${report.rankedByNobody.length} of ${activeTargets.length} ${targetNoun}. Rankings from earlier files still count.`,
    });
  }

  report.rankersInFile = [...rowsByRanker.keys()];
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
  status: "uploaded" | "validated" | "applied" | "failed" | "ignored",
  report: ImportValidationReport | null,
): ImportState {
  if (status === "failed") return "failed";
  if (status === "applied") return "applied";
  if (status === "ignored") return "ignored";
  if (!report) return "failed";
  if (report.unknownNames.length > 0) return "needs_mapping";
  if (report.errors.length > 0) return "needs_fixes";
  return "ready";
}
