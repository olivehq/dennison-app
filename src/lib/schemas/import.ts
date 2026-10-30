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

/** The upload card titles, also used in messages that send a file to another card. */
export const IMPORT_KIND_LABELS = {
  participants: "Participants",
  suppliers: "Suppliers",
  buyer_biztech_rankings: "Buyer biztech rankings",
  buyer_hotel_rankings: "Buyer hotel rankings",
  supplier_rankings: "Supplier rankings",
} as const satisfies Record<z.infer<typeof importKindSchema>, string>;

/**
 * "Save all suggested" takes a name only when its top suggestion scores at
 * least this and no other suggestion ties it. Suggestions never pair names
 * whose numbers differ, so what's left is a spelling difference.
 */
export const BULK_MAPPING_MIN_SCORE = 0.97;

/** `template` is an Olive roster template; `list` and `matrix` are the two ranking shapes (D18). */
export const importFormatSchema = z.enum(["template", "list", "matrix"]);

export const entityTypeSchema = z.enum(["buyer", "supplier"]);

/**
 * Derived from `imports.status` plus the validation report. The database enum
 * only distinguishes validated from applied, failed, and ignored; the UI needs
 * finer states to pick the right card.
 */
export const importStateSchema = z.enum([
  "failed",
  "needs_mapping",
  "needs_fixes",
  "ready",
  "applied",
  "ignored",
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
  /**
   * The text matches several people on the roster (a shared name or
   * organization); `suggestions` lists all of them. A mapping for it applies
   * to every row with this text, so it is never saved in bulk.
   */
  ambiguous: z.boolean().optional(),
});

const duplicateValueSchema = z.object({
  value: z.string(),
  rows: z.array(z.number().int()),
});

/** One field a roster file changes, with how many people and the first few names (shown before apply). */
const fieldChangeSchema = z.object({
  field: z.string(),
  count: z.number().int(),
  names: z.array(z.string()),
});

/** Roster kinds: what applying the file changes for people already on the roster, worked out at validation. */
const rosterChangesSchema = z.object({
  /** Rows that match someone on the roster and change at least one field. */
  updated: z.number().int(),
  /** Rows that match someone on the roster and change nothing. */
  unchanged: z.number().int(),
  fields: z.array(fieldChangeSchema),
  /** People who have both an organization and a title and lose one of them. */
  cleared: z.array(z.object({ name: z.string(), fields: z.array(z.string()) })),
  /** People on the roster with no row in the file. They are kept as is. */
  missing: z.array(z.string()),
});

/** A name in the file that resolved through a saved alias rather than a name on the roster. */
const aliasedNameSchema = z.object({
  raw: z.string(),
  entityType: entityTypeSchema,
  /** The roster label it resolved to. */
  name: z.string(),
  scope: z.enum(["event", "cross_year"]),
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
  /**
   * Ranking kinds: ids of the rankers the file has a row for. Applying the
   * file replaces only their rankings of this kind. Reports written before
   * this field existed read as empty.
   */
  rankersInFile: z.array(z.string()).default([]),
  /** Ranking kinds: names resolved through a saved alias. Absent on older reports. */
  aliasedNames: z.array(aliasedNameSchema).optional(),
  /** Roster kinds. Absent on older reports. */
  rosterChanges: rosterChangesSchema.optional(),
});

export const uploadImportSchema = z.object({
  eventId: z.uuid(),
  kind: importKindSchema,
});

export const saveAliasesSchema = z.object({
  eventId: z.uuid(),
  aliases: z
    .array(
      z.object({
        raw: z.string().trim().min(1, "The raw name is empty."),
        entityType: entityTypeSchema,
        entityId: z.uuid(),
      }),
    )
    .min(1, "Choose at least one name to map.")
    .max(500),
});

export const removeAliasSchema = z.object({
  eventId: z.uuid(),
  aliasId: z.uuid(),
});

export const IMPORT_FILE_EXTENSIONS = [".xlsx", ".xls", ".csv"] as const;
/** 4 MB: Vercel caps a function request body at 4.5 MB, multipart overhead included. */
export const IMPORT_MAX_FILE_BYTES = 4 * 1024 * 1024;

export type ImportKind = z.infer<typeof importKindSchema>;
export type RankingKind = z.infer<typeof rankingKindSchema>;
export type ImportFormat = z.infer<typeof importFormatSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
export type ImportState = z.infer<typeof importStateSchema>;
export type NameSuggestion = z.infer<typeof nameSuggestionSchema>;
export type UnknownName = z.infer<typeof unknownNameSchema>;
export type ImportValidationReport = z.infer<typeof importValidationReportSchema>;
export type UploadImportInput = z.infer<typeof uploadImportSchema>;
export type SaveAliasesInput = z.infer<typeof saveAliasesSchema>;
export type RemoveAliasInput = z.infer<typeof removeAliasSchema>;
export type AliasedName = z.infer<typeof aliasedNameSchema>;
export type RosterChanges = z.infer<typeof rosterChangesSchema>;

/** "A, B, and 3 more" when `names` is a sample of `total`, else "A, B, and C". Used by the report and the apply confirm. */
export function nameSample(names: string[], total = names.length): string {
  const rest = total - names.length;
  if (rest > 0) return `${names.join(", ")}, and ${rest} more`;
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

export function isRankingKind(kind: ImportKind): kind is RankingKind {
  return (rankingKinds as readonly string[]).includes(kind);
}
