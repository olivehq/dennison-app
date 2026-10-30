import { count, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { pendingFileDeletions } from "@/db/schema";
import { deleteFile } from "@/lib/storage";

/**
 * Stored files are deleted through a queue (D184). A caller that removes the
 * last row pointing at a file adds its key with `queueFileDeletions` in the
 * same transaction, so the database never forgets a file it still has to
 * delete. After the commit the caller calls `deleteQueuedFilesNow`; whatever
 * fails stays queued and the daily retention cron retries it with
 * `drainFileDeletions`.
 */

/** A key that has failed this many times is logged as a warning on every later failure. */
export const WARN_AFTER_ATTEMPTS = 5;

/** The longest wait before a failed key is due again, short enough that every daily cron run retries it. */
const MAX_BACKOFF_MINUTES = 6 * 60;

/** Minutes until a key that has failed `attempts` times is due again: 5, 10, 20, ... up to 6 hours. */
export function backoffMinutes(attempts: number): number {
  return Math.min(5 * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MINUTES);
}

/**
 * Queues files for deletion. Call it inside the transaction that removes the
 * rows that referenced them: the keys must no longer be referenced once it
 * commits. A key already queued keeps its attempts and schedule.
 */
export async function queueFileDeletions(tx: Db, keys: readonly string[]): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  await tx
    .insert(pendingFileDeletions)
    .values(unique.map((storageKey) => ({ storageKey })))
    .onConflictDoNothing();
}

export type DrainResult = {
  /** Files deleted, or already gone, and taken off the queue. */
  deleted: number;
  /** Keys whose delete failed this time; they stay queued. */
  failed: string[];
  /** Keys still queued after this drain, due or not. */
  pending: number;
  /** Queued keys that have failed `WARN_AFTER_ATTEMPTS` times or more. */
  failing: number;
};

/** The error's name and code. Storage messages can repeat the key's file name, so they are not kept. */
function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const code = (error as NodeJS.ErrnoException).code;
  return (code ? `${error.name} (${code})` : error.name).slice(0, 200);
}

/**
 * Deletes queued files from storage. With `keys`, tries those keys whatever
 * their schedule (the caller just queued them); without, every key that is due
 * at `now`, oldest first, up to `limit`. A deleted or already missing file
 * leaves the queue; a failure bumps `attempts`, records the error's name, and
 * backs off. Storage errors are not thrown; database errors are.
 */
export async function drainFileDeletions(
  db: Db,
  options: { keys?: readonly string[]; now?: Date; limit?: number } = {},
): Promise<DrainResult> {
  const now = options.now ?? new Date();
  const due = await db
    .select()
    .from(pendingFileDeletions)
    .where(
      options.keys
        ? inArray(pendingFileDeletions.storageKey, [...options.keys])
        : lte(pendingFileDeletions.nextAttemptAt, now),
    )
    .orderBy(pendingFileDeletions.nextAttemptAt)
    .limit(options.limit ?? 500);

  let deleted = 0;
  const failed: string[] = [];
  for (const row of due) {
    try {
      // The adapters treat a missing file as deleted.
      await deleteFile(row.storageKey);
    } catch (error) {
      const attempts = row.attempts + 1;
      const lastError = errorSummary(error);
      await db
        .update(pendingFileDeletions)
        .set({ attempts, lastError, nextAttemptAt: new Date(now.getTime() + backoffMinutes(attempts) * 60_000) })
        .where(eq(pendingFileDeletions.storageKey, row.storageKey));
      failed.push(row.storageKey);
      if (attempts >= WARN_AFTER_ATTEMPTS) {
        console.warn(`[files] ${row.storageKey} has failed to delete ${attempts} times (${lastError}). It stays queued; check storage.`);
      }
      continue;
    }
    await db.delete(pendingFileDeletions).where(eq(pendingFileDeletions.storageKey, row.storageKey));
    deleted += 1;
  }

  const [{ value: pending }] = await db.select({ value: count() }).from(pendingFileDeletions);
  const [{ value: failing }] = await db
    .select({ value: count() })
    .from(pendingFileDeletions)
    .where(gte(pendingFileDeletions.attempts, WARN_AFTER_ATTEMPTS));
  return { deleted, failed, pending, failing };
}

/**
 * Right after the commit that queued `keys`: tries to delete them now. Never
 * throws, so a storage or database hiccup can't fail an action that already
 * committed; what is left stays queued for the cron.
 */
export async function deleteQueuedFilesNow(db: Db, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await drainFileDeletions(db, { keys });
  } catch (error) {
    console.warn(`[files] ${keys.length} queued file(s) were not deleted now (${errorSummary(error)}). The retention cron retries them.`);
  }
}

/**
 * Deletes files that were stored but never referenced by a committed row,
 * such as an upload whose write failed or was refused. Queues them in their own
 * statement and tries them now. Never throws. When the queue can't be written
 * either, deletes directly and logs the keys a failed delete leaves behind.
 */
export async function discardStoredFiles(db: Db, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await queueFileDeletions(db, keys);
  } catch {
    for (const key of keys) {
      await deleteFile(key).catch((error: unknown) => {
        console.warn(`[files] ${key} was neither queued nor deleted (${errorSummary(error)}). Delete it by hand.`);
      });
    }
    return;
  }
  await deleteQueuedFilesNow(db, keys);
}
