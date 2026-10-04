import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { admins, events, participants } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas/event-settings";
import { listAudit } from "@/server/audit/audit";
import { assertEventEditable } from "./editable";
import { createEvent, deleteEvent, setRetainData, updateEvent, updateEventSettings } from "./events";
import { getEvent, getEventCounts, listEvents } from "./queries";

const ACTOR = "admin-test";
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(admins).values({ id: ACTOR, name: "Tester", email: "tester@example.com" });
});

async function makeEvent(name = "AW 2026") {
  const result = await createEvent(db, { name, eventDate: "2026-11-10", timezone: "America/Los_Angeles" }, ACTOR);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.id;
}

describe("createEvent", () => {
  it("creates a draft with the default settings and an audit row", async () => {
    const id = await makeEvent("Create test");
    const event = await getEvent(id, db);
    expect(event?.status).toBe("draft");
    expect(event?.settings).toEqual(defaultEventSettings);
    expect(event?.timezone).toBe("America/Los_Angeles");

    const audit = await listAudit({ eventId: id }, db);
    expect(audit.rows.map((r) => r.action)).toEqual(["event.create"]);
  });

  it("rejects a bad timezone and a bad date with field errors", async () => {
    const result = await createEvent(db, { name: "Bad", eventDate: "11/10/2026", timezone: "Mars/Olympus" }, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(Object.keys(result.error.fieldErrors ?? {})).toEqual(expect.arrayContaining(["eventDate", "timezone"]));
    }
  });
});

describe("updateEventSettings", () => {
  it("saves valid settings", async () => {
    const id = await makeEvent("Settings ok");
    const result = await updateEventSettings(db, id, { ...defaultEventSettings, buyerMin: 6 }, ACTOR);
    expect(result.ok).toBe(true);
    expect((await getEvent(id, db))?.settings.buyerMin).toBe(6);
  });

  it("rejects buyerMin above buyerMax", async () => {
    const id = await makeEvent("Settings min");
    const result = await updateEventSettings(db, id, { ...defaultEventSettings, buyerMin: 10, buyerMax: 9 }, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.fieldErrors?.buyerMin).toBeDefined();
    }
  });

  it("rejects overlapping slots", async () => {
    const id = await makeEvent("Settings overlap");
    const slots = defaultEventSettings.slots.map((slot, index) =>
      index === 1 ? { ...slot, startMinutes: defaultEventSettings.slots[0].endMinutes - 5 } : slot,
    );
    const result = await updateEventSettings(db, id, { ...defaultEventSettings, slots }, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.fieldErrors?.["slots.1.startMinutes"]).toBeDefined();
  });

  it("returns not_found for an unknown or malformed id", async () => {
    const unknown = await updateEventSettings(db, "00000000-0000-4000-8000-000000000000", defaultEventSettings, ACTOR);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("not_found");
    const malformed = await updateEventSettings(db, "not-a-uuid", defaultEventSettings, ACTOR);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("not_found");
  });
});

describe("locked events", () => {
  it("refuses settings and detail changes with code locked", async () => {
    const id = await makeEvent("Locked");
    await db.update(events).set({ status: "locked" }).where(eq(events.id, id));

    const settings = await updateEventSettings(db, id, defaultEventSettings, ACTOR);
    expect(settings.ok).toBe(false);
    if (!settings.ok) expect(settings.error.code).toBe("locked");

    const details = await updateEvent(db, id, { name: "Renamed", eventDate: "2026-11-11", timezone: "Europe/London" }, ACTOR);
    expect(details.ok).toBe(false);
    if (!details.ok) expect(details.error.code).toBe("locked");
    expect((await getEvent(id, db))?.name).toBe("Locked");
  });

  it("assertEventEditable passes draft, imported, and matched", () => {
    expect(assertEventEditable({ status: "draft" })).toBeNull();
    expect(assertEventEditable({ status: "imported" })).toBeNull();
    expect(assertEventEditable({ status: "matched" })).toBeNull();
    for (const status of ["locked", "sent", "archived"] as const) {
      const result = assertEventEditable({ status });
      expect(result?.ok).toBe(false);
      if (result && !result.ok) expect(result.error.code).toBe("locked");
    }
  });
});

describe("setRetainData", () => {
  it("works while locked, audits the change, and survives a settings save", async () => {
    const id = await makeEvent("Retain");
    await db.update(events).set({ status: "sent" }).where(eq(events.id, id));
    const on = await setRetainData(db, id, true, ACTOR);
    expect(on).toEqual({ ok: true, data: { id, retainData: true } });
    expect((await getEvent(id, db))?.settings.retainData).toBe(true);
    const audit = await listAudit({ eventId: id, filters: { action: "event.retention" } }, db);
    expect(audit.rows.map((r) => [r.before, r.after])).toEqual([[{ retainData: false }, { retainData: true }]]);

    // Saving again is a no-op with no second audit row.
    await setRetainData(db, id, true, ACTOR);
    expect((await listAudit({ eventId: id, filters: { action: "event.retention" } }, db)).total).toBe(1);

    // A settings form saved with a stale retainData leaves it alone.
    await db.update(events).set({ status: "matched" }).where(eq(events.id, id));
    const saved = await updateEventSettings(db, id, { ...defaultEventSettings, retainData: false, buyerMin: 6 }, ACTOR);
    expect(saved.ok).toBe(true);
    expect((await getEvent(id, db))?.settings).toMatchObject({ retainData: true, buyerMin: 6 });
  });

  it("refuses archived events and non-boolean input", async () => {
    const id = await makeEvent("Archived");
    expect(await setRetainData(db, id, "yes", ACTOR)).toMatchObject({ ok: false, error: { code: "validation" } });
    await db.update(events).set({ status: "archived" }).where(eq(events.id, id));
    expect(await setRetainData(db, id, true, ACTOR)).toMatchObject({ ok: false, error: { code: "locked" } });
  });
});

describe("updateEvent", () => {
  it("changes name, date, and timezone and records before and after", async () => {
    const id = await makeEvent("Rename me");
    const result = await updateEvent(db, id, { name: "Renamed", eventDate: "2026-11-12", timezone: "Europe/London" }, ACTOR);
    expect(result.ok).toBe(true);
    const event = await getEvent(id, db);
    expect(event?.name).toBe("Renamed");
    expect(event?.eventDate).toBe("2026-11-12");
    const audit = await listAudit({ eventId: id, filters: { action: "event.update" } }, db);
    expect(audit.rows[0]?.before).toMatchObject({ name: "Rename me" });
  });
});

describe("deleteEvent", () => {
  it("deletes an empty draft and files the audit row under no event", async () => {
    const id = await makeEvent("Delete me");
    const result = await deleteEvent(db, id, ACTOR);
    expect(result.ok).toBe(true);
    expect(await getEvent(id, db)).toBeNull();
    const audit = await listAudit({ eventId: null, filters: { action: "event.delete" } }, db);
    expect(audit.rows.some((r) => r.entityId === id)).toBe(true);
  });

  it("refuses when the event has participants", async () => {
    const id = await makeEvent("Has people");
    await db.insert(participants).values({ eventId: id, email: "a@example.com", firstName: "A", lastName: "B" });
    const result = await deleteEvent(db, id, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    expect(await getEvent(id, db)).not.toBeNull();
  });

  it("refuses when the event is not a draft", async () => {
    const id = await makeEvent("Imported");
    await db.update(events).set({ status: "imported" }).where(eq(events.id, id));
    const result = await deleteEvent(db, id, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });
});

describe("queries", () => {
  it("lists events with roster counts and reports counts for one event", async () => {
    const id = await makeEvent("Counted");
    await db.insert(participants).values([
      { eventId: id, email: "x@example.com", firstName: "X", lastName: "Y" },
      { eventId: id, email: "w@example.com", firstName: "W", lastName: "Z", status: "withdrawn" },
    ]);
    const list = await listEvents(db);
    const item = list.find((e) => e.id === id);
    expect(item?.participantCount).toBe(1);
    expect(item?.supplierCount).toBe(0);

    const counts = await getEventCounts(id, db);
    expect(counts).toEqual({ participants: 1, suppliers: 0, appointments: 0, activeRunId: null });
  });
});
