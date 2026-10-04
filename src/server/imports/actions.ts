"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { fail, fromZod, type ActionResult } from "@/lib/errors";
import {
  IMPORT_FILE_EXTENSIONS,
  IMPORT_MAX_FILE_BYTES,
  saveAliasesSchema,
  saveAliasSchema,
  uploadImportSchema,
  type ImportKind,
  type ImportState,
} from "@/lib/schemas/import";
import { requireAdmin } from "@/server/auth/session";
import { applyImport, createImport, deleteImportRecord, saveAlias, saveAliases, type ApplySummary } from "./imports";
import { getImport } from "./queries";

const idSchema = z.uuid();

function revalidateEvent(eventId: string): void {
  revalidatePath(`/events/${eventId}`, "layout");
}

function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return IMPORT_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Expects FormData with `eventId`, `kind`, and `file`. Accepts xlsx, xls, or
 * csv under 4 MB. A file that fails to parse still creates a `failed` import
 * so the admin sees the message on the card.
 */
export async function uploadImport(
  formData: FormData,
): Promise<ActionResult<{ importId: string; state: ImportState }>> {
  const actor = await requireAdmin();
  const parsed = uploadImportSchema.safeParse({
    eventId: formData.get("eventId"),
    kind: formData.get("kind"),
  });
  if (!parsed.success) return fromZod(parsed.error);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail("validation", "Choose a file to upload.", { file: ["Required."] });
  }
  if (!hasAllowedExtension(file.name)) {
    return fail("validation", "Upload an .xlsx, .xls, or .csv file.", {
      file: ["Use .xlsx, .xls, or .csv."],
    });
  }
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    return fail("validation", "The file is larger than 4 MB.", { file: ["Must be under 4 MB."] });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await createImport(getDb(), {
    eventId: parsed.data.eventId,
    kind: parsed.data.kind,
    filename: file.name,
    buffer,
    adminId: actor.id,
  });
  if (!result.ok) return result;
  revalidateEvent(parsed.data.eventId);
  return { ok: true, data: { importId: result.data.importId, state: result.data.state } };
}

export async function saveAliasAction(
  input: unknown,
): Promise<ActionResult<{ aliasId: string; imports: { importId: string; kind: ImportKind; state: ImportState }[] }>> {
  const actor = await requireAdmin();
  const parsed = saveAliasSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await saveAlias(getDb(), { ...parsed.data, adminId: actor.id });
  if (result.ok) revalidateEvent(parsed.data.eventId);
  return result;
}

/** Saves several mappings at once ("Save all suggested") and re-validates pending imports once. */
export async function saveAliasesAction(
  input: unknown,
): Promise<ActionResult<{ aliasIds: string[]; imports: { importId: string; kind: ImportKind; state: ImportState }[] }>> {
  const actor = await requireAdmin();
  const parsed = saveAliasesSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await saveAliases(getDb(), { ...parsed.data, adminId: actor.id });
  if (result.ok) revalidateEvent(parsed.data.eventId);
  return result;
}

export async function applyImportAction(
  importId: unknown,
): Promise<ActionResult<{ importId: string; summary: ApplySummary }>> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(importId);
  if (!parsed.success) return fromZod(parsed.error);
  const result = await applyImport(getDb(), { importId: parsed.data, adminId: actor.id });
  if (result.ok) {
    const row = await getImport(parsed.data);
    if (row) revalidateEvent(row.eventId);
  }
  return result;
}

export async function deleteImport(
  importId: unknown,
): Promise<ActionResult<{ importId: string; rankingsDeleted: number }>> {
  const actor = await requireAdmin();
  const parsed = idSchema.safeParse(importId);
  if (!parsed.success) return fromZod(parsed.error);
  const row = await getImport(parsed.data);
  const result = await deleteImportRecord(getDb(), { importId: parsed.data, adminId: actor.id });
  if (result.ok && row) revalidateEvent(row.eventId);
  return result;
}
