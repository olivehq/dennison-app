import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { events, type EventStatus } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas/event-settings";
import { advanceStatus } from "./status";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

async function makeEvent(status: EventStatus): Promise<string> {
  const [row] = await db
    .insert(events)
    .values({ name: `Status ${status}`, eventDate: "2026-11-10", timezone: "America/Los_Angeles", status, settings: defaultEventSettings })
    .returning({ id: events.id });
  return row.id;
}

async function statusOf(id: string): Promise<EventStatus> {
  const [row] = await db.select({ status: events.status }).from(events).where(eq(events.id, id));
  return row.status;
}

describe("advanceStatus", () => {
  it("moves the event when it is in the expected status", async () => {
    const id = await makeEvent("draft");
    expect(await advanceStatus(db, id, "draft", "imported")).toBe(true);
    expect(await statusOf(id)).toBe("imported");
  });

  it("leaves an event in any other status alone, so it never moves backwards", async () => {
    const id = await makeEvent("matched");
    expect(await advanceStatus(db, id, "draft", "imported")).toBe(false);
    expect(await statusOf(id)).toBe("matched");
  });

  it("accepts several from statuses", async () => {
    const id = await makeEvent("sent");
    expect(await advanceStatus(db, id, ["locked", "sent"], "matched")).toBe(true);
    expect(await statusOf(id)).toBe("matched");
    expect(await advanceStatus(db, id, [], "draft")).toBe(false);
  });

  it("rolls back with the surrounding transaction", async () => {
    const id = await makeEvent("draft");
    await expect(
      db.transaction(async (tx) => {
        await advanceStatus(tx, id, "draft", "imported");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await statusOf(id)).toBe("draft");
  });
});
