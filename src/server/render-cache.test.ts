import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, type Db } from "@/db/client";
import { events } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { getEvent } from "@/server/events/queries";
import { recordQueries } from "@/server/events/test-race";
import { seedEvent } from "@/server/matching/test-seed";
import { cachePerRender } from "./render-cache";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

describe("cachePerRender outside a render", () => {
  it("passes every call through, on the handle each caller gave", async () => {
    const read = vi.fn(async (_db: Db, id: string) => id);
    const cached = cachePerRender(read);
    const other = recordQueries(db).db;

    await cached(getDb(), "a");
    await cached(getDb(), "a");
    await cached(other, "a");

    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.map(([handle]) => handle === getDb())).toEqual([true, true, false]);
  });

  it("reads the database again each time, so a write in between is seen", async () => {
    const { eventId } = await seedEvent(db, { name: "Before" });
    const client = (getDb() as unknown as { $client: PGlite }).$client;
    const query = vi.spyOn(client, "query");

    expect((await getEvent(eventId))?.name).toBe("Before");
    await db.update(events).set({ name: "After" }).where(eq(events.id, eventId));
    expect((await getEvent(eventId, db))?.name).toBe("After");

    // Two reads plus the update.
    expect(query).toHaveBeenCalledTimes(3);
    query.mockRestore();
  });
});
