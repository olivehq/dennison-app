import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { events, type EventStatus } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { EventGate } from "@/lib/event-gates";
import { fail } from "@/lib/errors";
import { defaultEventSettings } from "@/lib/schemas/event-settings";
import { ARCHIVED_MESSAGE, EVENT_CHANGED_MESSAGE, EventChangedError, inEventTransaction, Refused } from "./editable";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await (db as unknown as { $client: { close(): Promise<void> } }).$client.close();
});

const statuses: EventStatus[] = ["draft", "imported", "matched", "locked", "sent", "archived"];
// Explicit expectations keep this contract independent of the implementation's gate table.
const allowed: Record<EventGate, EventStatus[]> = {
  edit: ["draft", "imported", "matched"],
  locked: ["locked", "sent"],
  unarchived: ["draft", "imported", "matched", "locked", "sent"],
  draft: ["draft"],
};
const lockedMessage = "The schedule is locked. Unlock it on the Schedule page to make changes.";

async function makeEvent(status: EventStatus) {
  const [event] = await db.insert(events).values({
    name: "Gate contract", eventDate: "2026-11-10", timezone: "America/Toronto",
    settings: defaultEventSettings, status,
  }).returning();
  return event;
}

for (const gate of Object.keys(allowed) as EventGate[]) {
  describe(gate, () => {
    it.each(statuses)("returns the precise result for %s", async (status) => {
      const event = await makeEvent(status);
      const work = vi.fn(async (_tx: Db, current: typeof event) => current.id);
      const result = await inEventTransaction(db, event.id, gate, work);
      if (allowed[gate].includes(status)) {
        expect(result).toEqual({ ok: true, data: event.id });
        expect(work).toHaveBeenCalledOnce();
      } else {
        const [code, message] =
          status === "archived" ? ["locked", ARCHIVED_MESSAGE]
          : gate === "edit" ? ["locked", lockedMessage]
          : gate === "locked" ? ["validation", "The schedule is not locked."]
          : gate === "draft" ? ["conflict", "Only draft events can be deleted. Archive this one instead."]
          : ["conflict", EVENT_CHANGED_MESSAGE];
        expect(result).toEqual({ ok: false, error: { code, message } });
        expect(work).not.toHaveBeenCalled();
      }
    });

    it("refuses a deleted event without calling work", async () => {
      const event = await makeEvent(allowed[gate][0]);
      await db.delete(events).where(eq(events.id, event.id));
      const work = vi.fn();
      expect(await inEventTransaction(db, event.id, gate, work)).toEqual({
        ok: false, error: { code: "not_found", message: "That event no longer exists." },
      });
      expect(work).not.toHaveBeenCalled();
    });

    it("rolls back a thrown EventChangedError and returns conflict", async () => {
      const event = await makeEvent(allowed[gate][0]);
      const result = await inEventTransaction(db, event.id, gate, async (tx) => {
        await tx.update(events).set({ name: "Must roll back" }).where(eq(events.id, event.id));
        throw new EventChangedError();
      });
      expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
      expect((await db.select().from(events).where(eq(events.id, event.id)))[0].name).toBe(event.name);
    });
  });
}

it("rolls back Refused and returns its exact result", async () => {
  const event = await makeEvent("draft");
  const refusal = fail("validation", "Choose a name.", { name: ["Required."] });
  expect(await inEventTransaction(db, event.id, "edit", async (tx) => {
    await tx.update(events).set({ name: "Must roll back" }).where(eq(events.id, event.id));
    throw new Refused(refusal);
  })).toEqual(refusal);
  expect((await db.select().from(events).where(eq(events.id, event.id)))[0].name).toBe(event.name);
});

it("rethrows unexpected errors after rolling back", async () => {
  const event = await makeEvent("draft");
  const error = new Error("Unexpected");
  await expect(inEventTransaction(db, event.id, "edit", async (tx) => {
    await tx.update(events).set({ name: "Must roll back" }).where(eq(events.id, event.id));
    throw error;
  })).rejects.toBe(error);
  expect((await db.select().from(events).where(eq(events.id, event.id)))[0].name).toBe(event.name);
});
