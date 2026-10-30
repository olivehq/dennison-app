import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { events } from "@/db/schema";
import {
  brandingColorsSchema,
  LOGO_MAX_BYTES,
  sniffLogoType,
  type EventBranding,
  type LogoType,
} from "@/lib/branding";
import { fail, fromZod, ok, type ActionResult } from "@/lib/errors";
import { getFile, putFile, type StoredFile } from "@/lib/storage";
import { recordAudit } from "@/server/audit/audit";
import { deleteQueuedFilesNow, discardStoredFiles, queueFileDeletions } from "@/server/files/cleanup";
import { inEventTransaction } from "./editable";
import { getEvent } from "./queries";

const LOGO_EXTENSION: Record<LogoType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export type SaveBrandingInput = {
  /** `primaryColor` and `accentColor`, each a hex color or "". */
  colors: unknown;
  /** A new logo. Replaces the current one. */
  logo?: Buffer | null;
  removeLogo?: boolean;
};

/**
 * Saves the colors and logo shown on the participant schedule page. Allowed in
 * every status but archived: the page is what participants see after the
 * schedule is locked and sent, so D&A may fix it then (D181). The old logo file
 * is queued for deletion with the row change and deleted after the commit; a
 * new file the row never pointed at is discarded when the write fails (D184).
 */
export async function saveBranding(
  db: Db,
  id: string,
  input: SaveBrandingInput,
  actorId: string,
): Promise<ActionResult<{ id: string }>> {
  // Refuse before uploading a logo to storage outside the transaction.
  const event = await getEvent(id, db);
  if (!event) return fail("not_found", "That event no longer exists.");
  if (event.status === "archived") return fail("locked", "This event is archived, so its branding can't change.");

  const colors = brandingColorsSchema.safeParse(input.colors);
  if (!colors.success) return fromZod(colors.error);

  let uploaded: { key: string; type: LogoType } | null = null;
  if (input.logo) {
    if (input.logo.byteLength > LOGO_MAX_BYTES) {
      return fail("validation", "The logo is larger than 300 KB.", { logo: ["Must be under 300 KB."] });
    }
    const type = sniffLogoType(input.logo);
    if (!type) {
      return fail("validation", "Upload a PNG, JPEG, WebP, or SVG logo.", { logo: ["Use a PNG, JPEG, WebP, or SVG file."] });
    }
    // A new key for every upload, so a replaced logo never serves stale from a cache.
    const key = `events/${event.id}/branding/logo-${crypto.randomUUID()}.${LOGO_EXTENSION[type]}`;
    await putFile({ key, body: input.logo, contentType: type });
    uploaded = { key, type };
  }

  let done: ActionResult<string | null>;
  try {
    done = await inEventTransaction(db, event.id, "unarchived", async (tx, current) => {
      const before = current.branding;
      const keepLogo = !input.removeLogo && !uploaded;
      const after: EventBranding = {
        primaryColor: colors.data.primaryColor || null,
        accentColor: colors.data.accentColor || null,
        logoKey: uploaded ? uploaded.key : keepLogo ? (before?.logoKey ?? null) : null,
        logoType: uploaded ? uploaded.type : keepLogo ? (before?.logoType ?? null) : null,
      };
      await tx.update(events).set({ branding: after }).where(eq(events.id, event.id));
      await recordAudit(tx, {
        eventId: event.id,
        adminId: actorId,
        action: "event.branding",
        entityType: "event",
        entityId: event.id,
        before: before ?? null,
        after,
      });
      const replacedKey = before?.logoKey && before.logoKey !== after.logoKey ? before.logoKey : null;
      if (replacedKey) await queueFileDeletions(tx, [replacedKey]);
      return replacedKey;
    });
  } catch (error) {
    if (uploaded) await discardStoredFiles(db, [uploaded.key]);
    throw error;
  }
  if (!done.ok) {
    if (uploaded) await discardStoredFiles(db, [uploaded.key]);
    return done;
  }

  if (done.data) await deleteQueuedFilesNow(db, [done.data]);
  return ok({ id: event.id });
}

const LOGO_FILE = /^logo-[0-9a-f-]{36}\.(png|jpg|webp|svg)$/;

/**
 * Where the page loads the logo from: `/api/branding/<eventId>/<file>`. The
 * file name is new for every upload, so the response can be cached forever.
 */
export function logoUrl(eventId: string, branding: EventBranding | null): string | null {
  if (!branding?.logoKey) return null;
  return `/api/branding/${eventId}/${branding.logoKey.slice(branding.logoKey.lastIndexOf("/") + 1)}`;
}

/**
 * The event's current logo file, or null when `file` is not the current logo,
 * the file is gone, or storage fails. A logo is cosmetic, so a storage outage
 * only drops the image, never the schedule.
 */
export async function loadCurrentLogo(eventId: string, file: string, db: Db = getDb()): Promise<StoredFile | null> {
  if (!LOGO_FILE.test(file)) return null;
  const event = await getEvent(eventId, db);
  const key = `events/${eventId}/branding/${file}`;
  if (!event || event.branding?.logoKey !== key) return null;
  try {
    return await getFile(key);
  } catch (error) {
    console.error(`[events] logo ${key} could not be read.`, error);
    return null;
  }
}
