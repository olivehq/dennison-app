import type { SheetRows } from "@/lib/xlsx";
import { supplierColumns } from "../templates";
import {
  blankToNull,
  columnReader,
  missingColumnsMessage,
  optionalReader,
  parseEmail,
} from "./shared";
import type { ParsedRows, ParsedSupplier } from "./types";

const TYPE_WORDS: Record<string, "business" | "hotel"> = {
  business: "business",
  biztech: "business",
  "business/tech": "business",
  tech: "business",
  hotel: "hotel",
  destination: "hotel",
  "hotel/destination": "hotel",
};

function parseType(value: string): "business" | "hotel" | null {
  return TYPE_WORDS[value.trim().toLowerCase()] ?? null;
}

type ContactResult = { name: string | null; email: string | null } | { error: string };

function parseContact(label: string, name: string, email: string): ContactResult {
  const trimmedEmail = email.trim();
  if (trimmedEmail === "") return { name: blankToNull(name), email: null };
  const parsedEmail = parseEmail(trimmedEmail);
  if (!parsedEmail) return { error: `${label} email "${trimmedEmail}" is not valid.` };
  return { name: blankToNull(name), email: parsedEmail };
}

/** Olive suppliers template. Name and a known type are required (D4). */
export function parseSuppliers(sheet: SheetRows): ParsedRows<ParsedSupplier> {
  const name = columnReader(sheet, supplierColumns.name);
  const type = columnReader(sheet, supplierColumns.type);
  if (!name || !type) {
    const missing = [name ? null : supplierColumns.name, type ? null : supplierColumns.type].filter(
      (column) => column !== null,
    );
    return { rows: [], errors: [{ row: null, message: missingColumnsMessage(missing) }] };
  }
  const adminName = optionalReader(sheet, supplierColumns.adminContactName);
  const adminEmail = optionalReader(sheet, supplierColumns.adminContactEmail);
  const attendeeName = optionalReader(sheet, supplierColumns.attendeeContactName);
  const attendeeEmail = optionalReader(sheet, supplierColumns.attendeeContactEmail);

  const rows: ParsedSupplier[] = [];
  const errors: ParsedRows<ParsedSupplier>["errors"] = [];
  sheet.rows.forEach((record, index) => {
    const row = sheet.rowNumbers[index];
    const supplierName = name(record);
    if (supplierName === "") {
      errors.push({ row, message: "Supplier name is missing." });
      return;
    }
    const supplierType = parseType(type(record));
    if (!supplierType) {
      errors.push({
        row,
        message: `${supplierName}: type must be business or hotel, got "${type(record)}".`,
      });
      return;
    }
    const admin = parseContact("Admin contact", adminName(record), adminEmail(record));
    if ("error" in admin) {
      errors.push({ row, message: `${supplierName}: ${admin.error}` });
      return;
    }
    const attendee = parseContact("Attendee contact", attendeeName(record), attendeeEmail(record));
    if ("error" in attendee) {
      errors.push({ row, message: `${supplierName}: ${attendee.error}` });
      return;
    }
    rows.push({
      row,
      name: supplierName,
      type: supplierType,
      adminContactName: admin.name,
      adminContactEmail: admin.email,
      attendeeContactName: attendee.name,
      attendeeContactEmail: attendee.email,
    });
  });
  return { rows, errors };
}
