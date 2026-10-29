import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { pendingFileDeletions } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { failNextDeletesForTests, getFile, putFile, useMemoryStorageForTests } from "@/lib/storage";
import {
  backoffMinutes,
  deleteQueuedFilesNow,
  discardStoredFiles,
  drainFileDeletions,
  queueFileDeletions,
  WARN_AFTER_ATTEMPTS,
} from "./cleanup";

let db: Db;

beforeAll(async () => {
  useMemoryStorageForTests();
  db = await createTestDb();
});

beforeEach(async () => {
  failNextDeletesForTests(0);
  await db.delete(pendingFileDeletions);
});

async function store(key: string): Promise<string> {
  await putFile({ key, body: Buffer.from("x"), contentType: "text/csv" });
  return key;
}

async function queued(key: string) {
  const [row] = await db.select().from(pendingFileDeletions).where(eq(pendingFileDeletions.storageKey, key));
  return row ?? null;
}

describe("file cleanup queue", () => {
  it("queues keys only when the transaction commits", async () => {
    const key = await store("events/e1/imports/i1/rolled-back.csv");
    await expect(
      db.transaction(async (tx) => {
        await queueFileDeletions(tx, [key]);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await queued(key)).toBeNull();

    await db.transaction((tx) => queueFileDeletions(tx, [key, key]));
    expect(await queued(key)).toMatchObject({ attempts: 0, lastError: null });
  });

  it("keeps a key whose delete fails, and the next drain removes it", async () => {
    const key = await store("events/e1/imports/i2/flaky.csv");
    await queueFileDeletions(db, [key]);
    const now = new Date("2027-01-01T09:00:00Z");

    failNextDeletesForTests();
    const first = await drainFileDeletions(db, { now });
    expect(first).toEqual({ deleted: 0, failed: [key], pending: 1, failing: 0 });
    expect(await getFile(key)).not.toBeNull();
    const row = await queued(key);
    // The error's name only: the message repeats the key.
    expect(row).toMatchObject({ attempts: 1, lastError: "StorageUnavailableError" });
    expect(row!.nextAttemptAt.getTime()).toBe(now.getTime() + backoffMinutes(1) * 60_000);

    // Not due yet, so a drain right away leaves it.
    expect(await drainFileDeletions(db, { now })).toMatchObject({ deleted: 0, failed: [], pending: 1 });

    const next = await drainFileDeletions(db, { now: new Date("2027-01-02T09:00:00Z") });
    expect(next).toEqual({ deleted: 1, failed: [], pending: 0, failing: 0 });
    expect(await getFile(key)).toBeNull();
    expect(await queued(key)).toBeNull();
  });

  it("counts a file that is already gone as done", async () => {
    const key = "events/e1/imports/i3/never-stored.csv";
    await queueFileDeletions(db, [key]);
    expect(await drainFileDeletions(db)).toEqual({ deleted: 1, failed: [], pending: 0, failing: 0 });
    expect(await queued(key)).toBeNull();
  });

  it("backs off up to six hours, so every daily run retries, and warns once a key keeps failing", async () => {
    expect([1, 2, 3, 8, 50].map(backoffMinutes)).toEqual([5, 10, 20, 360, 360]);

    const key = await store("events/e1/imports/i4/stuck.csv");
    await queueFileDeletions(db, [key]);
    await db.update(pendingFileDeletions).set({ attempts: WARN_AFTER_ATTEMPTS - 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      failNextDeletesForTests();
      const result = await drainFileDeletions(db);
      expect(result).toMatchObject({ failed: [key], pending: 1, failing: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(key);
    } finally {
      warn.mockRestore();
    }
  });

  it("deleteQueuedFilesNow tries only the given keys, whatever their schedule, and never throws", async () => {
    const mine = await store("events/e1/imports/i5/mine.csv");
    const other = await store("events/e1/imports/i5/other.csv");
    await queueFileDeletions(db, [mine, other]);
    await db.update(pendingFileDeletions).set({ nextAttemptAt: new Date("2100-01-01T00:00:00Z") });

    await deleteQueuedFilesNow(db, [mine]);
    expect(await getFile(mine)).toBeNull();
    expect(await queued(mine)).toBeNull();
    expect(await getFile(other)).not.toBeNull();
    expect(await queued(other)).not.toBeNull();

    failNextDeletesForTests();
    await expect(deleteQueuedFilesNow(db, [other])).resolves.toBeUndefined();
    expect(await queued(other)).toMatchObject({ attempts: 1 });
  });

  it("discardStoredFiles deletes a never-referenced upload, or leaves it queued when storage fails", async () => {
    const gone = await store("events/e1/branding/logo-a.png");
    await discardStoredFiles(db, [gone]);
    expect(await getFile(gone)).toBeNull();
    expect(await queued(gone)).toBeNull();

    const kept = await store("events/e1/branding/logo-b.png");
    failNextDeletesForTests();
    await discardStoredFiles(db, [kept]);
    expect(await getFile(kept)).not.toBeNull();
    expect(await queued(kept)).toMatchObject({ attempts: 1 });
  });
});
