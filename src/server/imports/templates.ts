import type { ImportFormat, ImportKind } from "@/lib/schemas/import";
import { writeSheet } from "@/lib/xlsx";

export type TemplateColumn = {
  header: string;
  required: boolean;
  description: string;
  /** Other header spellings the parser accepts, compared case-insensitively after normalising. */
  aliases: readonly string[];
};

export type ImportTemplate = {
  kind: ImportKind;
  title: string;
  description: string;
  formats: readonly ImportFormat[];
  columns: readonly TemplateColumn[];
};

export const participantColumns = {
  email: {
    header: "Email",
    required: true,
    description: "Identifies the participant. Re-importing updates the row with this email.",
    aliases: ["email", "email address", "e-mail"],
  },
  firstName: {
    header: "First name",
    required: true,
    description: "",
    aliases: ["first name", "first", "first_name", "given name"],
  },
  lastName: {
    header: "Last name",
    required: true,
    description: "",
    aliases: ["last name", "last", "last_name", "surname", "family name"],
  },
  organization: {
    header: "Organization",
    required: false,
    description: "Shown with the title as the display name, as in 2025.",
    aliases: ["organization", "organisation", "company", "org"],
  },
  title: {
    header: "Title",
    required: false,
    description: "",
    aliases: ["title", "job title", "position"],
  },
  biztechOptIn: {
    header: "Biztech opt-in",
    required: false,
    description: "yes or no. Leave blank to keep the current value.",
    aliases: ["biztech opt-in", "biztech opt in", "biztech", "biztech_opt_in", "opt-in", "opt in"],
  },
} as const satisfies Record<string, TemplateColumn>;

export const supplierColumns = {
  name: {
    header: "Name",
    required: true,
    description: "Identifies the supplier. Re-importing updates the row with this name.",
    aliases: ["name", "supplier", "supplier name", "company", "organization"],
  },
  type: {
    header: "Type",
    required: true,
    description: "business or hotel (D4).",
    aliases: ["type", "supplier type", "category"],
  },
  adminContactName: {
    header: "Admin contact name",
    required: false,
    description: "",
    aliases: ["admin contact name", "admin name", "admin contact"],
  },
  adminContactEmail: {
    header: "Admin contact email",
    required: false,
    description: "Receives the supplier schedule link.",
    aliases: ["admin contact email", "admin email"],
  },
  attendeeContactName: {
    header: "Attendee contact name",
    required: false,
    description: "",
    aliases: ["attendee contact name", "attendee name", "attendee contact", "attendee"],
  },
  attendeeContactEmail: {
    header: "Attendee contact email",
    required: false,
    description: "Receives the attendee schedule link.",
    aliases: ["attendee contact email", "attendee email"],
  },
} as const satisfies Record<string, TemplateColumn>;

export const rankingListColumns = {
  firstName: {
    header: "FIRST_NAME",
    required: false,
    description: "Used with LAST_NAME when FULL_NAME is missing.",
    aliases: ["first_name", "first name", "first"],
  },
  lastName: {
    header: "LAST_NAME",
    required: false,
    description: "",
    aliases: ["last_name", "last name", "last"],
  },
  fullName: {
    header: "FULL_NAME",
    required: true,
    description: "Matched to the roster through the alias table (D3).",
    aliases: ["full_name", "full name", "name", "attendee", "supplier", "buyer"],
  },
  email: {
    header: "EMAIL",
    required: false,
    description: "Optional. When present it identifies the row instead of the name.",
    aliases: ["email", "email address", "e-mail"],
  },
  choice: {
    header: "CHOICE #1 ... CHOICE #N",
    required: true,
    description: "One name per cell, in rank order. Missing names are unranked, not rejected (D2).",
    aliases: [],
  },
} as const satisfies Record<string, TemplateColumn>;

const rankingFormats: readonly ImportFormat[] = ["list", "matrix"];

export const templates: Record<ImportKind, ImportTemplate> = {
  participants: {
    kind: "participants",
    title: "Participants",
    description: "One row per buyer. Email is the identity.",
    formats: ["template"],
    columns: Object.values(participantColumns),
  },
  suppliers: {
    kind: "suppliers",
    title: "Suppliers",
    description: "One row per supplier with its type and contacts (D25).",
    formats: ["template"],
    columns: Object.values(supplierColumns),
  },
  buyer_biztech_rankings: {
    kind: "buyer_biztech_rankings",
    title: "Buyer rankings of business suppliers",
    description:
      "eShow export: one row per participant, CHOICE #n columns name business suppliers. Also sets biztech opt-in (D1).",
    formats: rankingFormats,
    columns: Object.values(rankingListColumns),
  },
  buyer_hotel_rankings: {
    kind: "buyer_hotel_rankings",
    title: "Buyer rankings of hotel suppliers",
    description: "eShow export: one row per participant, CHOICE #n columns name hotel suppliers.",
    formats: rankingFormats,
    columns: Object.values(rankingListColumns),
  },
  supplier_rankings: {
    kind: "supplier_rankings",
    title: "Supplier rankings of buyers",
    description: "eShow export: one row per supplier, CHOICE #n columns name participants.",
    formats: rankingFormats,
    columns: Object.values(rankingListColumns),
  },
};

export type TemplateSummary = {
  kind: ImportKind;
  title: string;
  description: string;
  formats: readonly ImportFormat[];
  columns: { header: string; required: boolean; description: string }[];
};

/** Serialisable description of every template for the upload cards. */
export const templateSummary: TemplateSummary[] = Object.values(templates).map((template) => ({
  kind: template.kind,
  title: template.title,
  description: template.description,
  formats: template.formats,
  columns: template.columns.map(({ header, required, description }) => ({
    header,
    required,
    description,
  })),
}));

export const CHOICE_HEADER = /^choice\s*#?\s*(\d+)$/i;

const MATRIX_CORNER_HEADERS = new Set([
  "",
  "name",
  "buyer",
  "buyers",
  "buyer name",
  "supplier",
  "suppliers",
  "supplier name",
  "company",
  "organization",
  "participant",
  "attendee",
]);

export function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

/**
 * `list` when any header is a CHOICE #n column. `matrix` when the first header
 * is blank or a generic label and every other header is a name (no CHOICE
 * columns, at least two entity columns). Anything else is unknown.
 */
export function detectFormat(headers: string[]): "list" | "matrix" | "unknown" {
  if (headers.some((header) => CHOICE_HEADER.test(header.trim()))) return "list";
  if (headers.length < 3) return "unknown";
  const [first, ...rest] = headers;
  if (!MATRIX_CORNER_HEADERS.has(normaliseHeader(first))) return "unknown";
  if (rest.some((header) => header.trim() === "")) return "unknown";
  return "matrix";
}

/** Index of the first header matching one of the column's aliases, or -1. */
export function findColumn(headers: string[], column: TemplateColumn): number {
  const wanted = new Set(column.aliases.map(normaliseHeader));
  wanted.add(normaliseHeader(column.header));
  return headers.findIndex((header) => wanted.has(normaliseHeader(header)));
}

/** An empty workbook with the template's headers, for the download link on the upload card. */
export function templateWorkbook(kind: ImportKind): Buffer {
  const template = templates[kind];
  if (template.formats.includes("template")) {
    return writeSheet(
      template.columns.map((column) => column.header),
      [],
      template.title,
    );
  }
  const headers = ["FIRST_NAME", "LAST_NAME", "FULL_NAME", "EMAIL"];
  for (let n = 1; n <= 40; n += 1) headers.push(`CHOICE #${n}`);
  return writeSheet(headers, [], "Report");
}
