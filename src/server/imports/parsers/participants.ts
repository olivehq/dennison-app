import type { SheetRows } from "@/lib/xlsx";
import { participantColumns } from "../templates";
import {
  blankToNull,
  columnReader,
  missingColumnsMessage,
  optionalReader,
  parseEmail,
  parseYesNo,
} from "./shared";
import type { ParsedParticipant, ParsedRows } from "./types";

/** Olive participants template. Rows missing a valid email or a name are reported and skipped. */
export function parseParticipants(sheet: SheetRows): ParsedRows<ParsedParticipant> {
  const email = columnReader(sheet, participantColumns.email);
  const firstName = columnReader(sheet, participantColumns.firstName);
  const lastName = columnReader(sheet, participantColumns.lastName);
  const missing = [
    email ? null : participantColumns.email,
    firstName ? null : participantColumns.firstName,
    lastName ? null : participantColumns.lastName,
  ].filter((column) => column !== null);
  if (!email || !firstName || !lastName) {
    return { rows: [], errors: [{ row: null, message: missingColumnsMessage(missing) }] };
  }
  const organization = optionalReader(sheet, participantColumns.organization);
  const title = optionalReader(sheet, participantColumns.title);
  const biztech = optionalReader(sheet, participantColumns.biztechOptIn);

  const rows: ParsedParticipant[] = [];
  const errors: ParsedRows<ParsedParticipant>["errors"] = [];
  sheet.rows.forEach((record, index) => {
    const row = sheet.rowNumbers[index];
    const rawEmail = email(record);
    const parsedEmail = parseEmail(rawEmail);
    if (rawEmail === "") {
      errors.push({ row, message: "Email is missing.", code: "missing_email" });
      return;
    }
    if (!parsedEmail) {
      errors.push({ row, message: `"${rawEmail}" is not a valid email address.` });
      return;
    }
    const first = firstName(record);
    const last = lastName(record);
    if (first === "" || last === "") {
      errors.push({ row, message: `${parsedEmail}: first and last name are required.` });
      return;
    }
    const optIn = parseYesNo(biztech(record));
    if (optIn === undefined) {
      errors.push({
        row,
        message: `${parsedEmail}: Biztech opt-in must be yes or no, got "${biztech(record)}".`,
      });
      return;
    }
    rows.push({
      row,
      email: parsedEmail,
      firstName: first,
      lastName: last,
      organization: blankToNull(organization(record)),
      title: blankToNull(title(record)),
      biztechOptIn: optIn,
    });
  });
  return { rows, errors };
}
