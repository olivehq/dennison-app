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
    description:
      "One name per cell, in rank order. Missing names are unranked, not rejected (D2). In the supplier file a cell can also hold the buyer's email or company.",
    aliases: [],
  },
} as const satisfies Record<string, TemplateColumn>;

/** The supplier rankings layout: the ranker is a supplier, named by SUPPLIER or FULL_NAME. */
export const supplierRankingListColumns = {
  supplier: {
    header: "SUPPLIER",
    required: true,
    description: "The supplier's name as on the roster. FULL_NAME also works.",
    aliases: rankingListColumns.fullName.aliases,
  },
  email: {
    header: "EMAIL",
    required: false,
    description: "Optional. The supplier's admin or attendee contact email; when present it identifies the row instead of the name.",
    aliases: rankingListColumns.email.aliases,
  },
  choice: {
    header: "CHOICE #1 ... CHOICE #N",
    required: true,
    description:
      "One buyer per cell, in rank order: their email (matched first), full name, or company. Use the email when two buyers share a name or company.",
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
    description:
      "eShow export: one row per supplier, CHOICE #n columns name participants. A choice can be the buyer's email (matched first), name, or company. Use the email when two buyers share a name or company.",
    formats: rankingFormats,
    columns: Object.values(supplierRankingListColumns),
  },
};

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

/**
 * Which kind of file the headers describe, or null when they match none or
 * more than one. Used to refuse a file dropped on the wrong card, so it only
 * answers when the shape is unambiguous: a participants file with Organization
 * and Category columns also looks like a suppliers file (name and type), and
 * then the card's own parser decides.
 */
export function detectShape(headers: string[]): "participants" | "suppliers" | "rankings" | null {
  if (headers.some((header) => CHOICE_HEADER.test(header.trim()))) return "rankings";
  const has = (column: TemplateColumn) => findColumn(headers, column) !== -1;
  const suppliers = has(supplierColumns.name) && has(supplierColumns.type);
  const participants = has(participantColumns.email) && has(participantColumns.firstName) && has(participantColumns.lastName);
  if (suppliers === participants) return null;
  return suppliers ? "suppliers" : "participants";
}

const CHOICE_COUNT = 40;

/**
 * The example row of the participants and suppliers templates. Those imports
 * create people, so an example row left in a filled template is refused by
 * validation instead of becoming a real participant or supplier.
 */
export const EXAMPLE_PARTICIPANT_EMAIL = "jane.doe@example.com";
export const EXAMPLE_SUPPLIER_NAME = "Example Bay Hotel";

/**
 * Header and one example row per kind (scope change order: "Download buttons
 * for each Olive template, with an example row"). The three ranking files
 * differ in who ranks and what the choices name. Names use example.com so a
 * forgotten example row in a ranking file shows up as an unknown name; in the
 * participants and suppliers files validation refuses it (see above).
 */
const TEMPLATE_SHEETS: Record<ImportKind, { sheet: string; headers: string[]; example: string[] }> = {
  participants: {
    sheet: "Participants",
    headers: Object.values(participantColumns).map((column) => column.header),
    example: [EXAMPLE_PARTICIPANT_EMAIL, "Jane", "Doe", "Example Meetings Co", "Meeting planner", "yes"],
  },
  suppliers: {
    sheet: "Suppliers",
    headers: Object.values(supplierColumns).map((column) => column.header),
    example: [EXAMPLE_SUPPLIER_NAME, "hotel", "Sam Lee", "sam.lee@example.com", "Ana Ruiz", "ana.ruiz@example.com"],
  },
  buyer_biztech_rankings: {
    sheet: "Biztech rankings",
    headers: ["FIRST_NAME", "LAST_NAME", "FULL_NAME", "EMAIL"],
    example: ["Jane", "Doe", "Jane Doe", "jane.doe@example.com", "Example AV Services", "Example Event Apps"],
  },
  buyer_hotel_rankings: {
    sheet: "Hotel rankings",
    headers: ["FIRST_NAME", "LAST_NAME", "FULL_NAME", "EMAIL"],
    example: ["Jane", "Doe", "Jane Doe", "jane.doe@example.com", "Example Bay Hotel", "Example Valley Resort"],
  },
  supplier_rankings: {
    sheet: "Supplier rankings",
    headers: ["SUPPLIER", "EMAIL"],
    example: ["Example Bay Hotel", "sam.lee@example.com", "jane.doe@example.com", "Chris Park", "Example Meetings Co"],
  },
};

/** The template workbook with its example row, for the download link on the upload card. */
export function templateWorkbook(kind: ImportKind): Buffer {
  const { sheet, headers, example } = TEMPLATE_SHEETS[kind];
  const choices = templates[kind].formats.includes("template")
    ? []
    : Array.from({ length: CHOICE_COUNT }, (_, i) => `CHOICE #${i + 1}`);
  return writeSheet([...headers, ...choices], [example], sheet);
}
