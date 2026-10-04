import { z } from "zod";

export const importKindSchema = z.enum([
  "participants",
  "suppliers",
  "buyer_biztech_rankings",
  "buyer_hotel_rankings",
  "supplier_rankings",
]);

export const rankingKinds = [
  "buyer_biztech_rankings",
  "buyer_hotel_rankings",
  "supplier_rankings",
] as const;

export const rankingKindSchema = z.enum(rankingKinds);

/** `template` is an Olive roster template; `list` and `matrix` are the two ranking shapes (D18). */
export const importFormatSchema = z.enum(["template", "list", "matrix"]);

export const entityTypeSchema = z.enum(["buyer", "supplier"]);

/**
 * Derived from `imports.status` plus the validation report. The database enum
 * only distinguishes validated from applied and failed; the UI needs finer
 * states to pick the right card.
 */
export const importStateSchema = z.enum([
  "failed",
  "needs_mapping",
  "needs_fixes",
  "ready",
  "applied",
]);

const rowMessageSchema = z.object({
  row: z.number().int().nullable(),
  message: z.string(),
});

export const nameSuggestionSchema = z.object({
  entityId: z.string(),
  name: z.string(),
  score: z.number(),
});

export const unknownNameSchema = z.object({
  raw: z.string(),
  entityType: entityTypeSchema,
  /** Whether the name stood in the ranker column or in a choice cell. */
  role: z.enum(["ranker", "target"]),
  rows: z.array(z.number().int()),
  suggestions: z.array(nameSuggestionSchema),
});

const duplicateValueSchema = z.object({
  value: z.string(),
  rows: z.array(z.number().int()),
});

const namedEntitySchema = z.object({
  entityId: z.string(),
  name: z.string(),
});

export const importValidationReportSchema = z.object({
  format: importFormatSchema.nullable(),
  counts: z.object({
    rows: z.number().int(),
    /** Rows that resolved to a ranker, ranking kinds only. */
    rankers: z.number().int(),
    /** Ranking rows that will be written on apply, ranking kinds only. */
    rankings: z.number().int(),
    resolvedNames: z.number().int(),
    unknownNames: z.number().int(),
    errors: z.number().int(),
    warnings: z.number().int(),
  }),
  errors: z.array(rowMessageSchema),
  warnings: z.array(rowMessageSchema),
  /** Raw strings only, kept for the `imports.validation` column type. */
  unresolvedNames: z.array(z.string()),
  unknownNames: z.array(unknownNameSchema),
  duplicateEmails: z.array(duplicateValueSchema),
  duplicateNames: z.array(duplicateValueSchema),
  missingEmails: z.array(z.number().int()),
  rowsWithZeroRankings: z.array(z.object({ row: z.number().int(), name: z.string() })),
  rankedByNobody: z.array(namedEntitySchema),
  rankedNobody: z.array(namedEntitySchema),
});

export const uploadImportSchema = z.object({
  eventId: z.uuid(),
  kind: importKindSchema,
});

export const saveAliasSchema = z.object({
  eventId: z.uuid(),
  raw: z.string().trim().min(1, "The raw name is empty."),
  entityType: entityTypeSchema,
  entityId: z.uuid(),
});

export const IMPORT_FILE_EXTENSIONS = [".xlsx", ".xls", ".csv"] as const;
export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export type ImportKind = z.infer<typeof importKindSchema>;
export type RankingKind = z.infer<typeof rankingKindSchema>;
export type ImportFormat = z.infer<typeof importFormatSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
export type ImportState = z.infer<typeof importStateSchema>;
export type NameSuggestion = z.infer<typeof nameSuggestionSchema>;
export type UnknownName = z.infer<typeof unknownNameSchema>;
export type ImportValidationReport = z.infer<typeof importValidationReportSchema>;
export type UploadImportInput = z.infer<typeof uploadImportSchema>;
export type SaveAliasInput = z.infer<typeof saveAliasSchema>;

export function isRankingKind(kind: ImportKind): kind is RankingKind {
  return (rankingKinds as readonly string[]).includes(kind);
}
