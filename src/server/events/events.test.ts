import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { admins, emailCampaigns, events, imports, participants } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings, type EventSettings } from "@/lib/schemas/event-settings";
import { getFile, importFileKey, putFile, useMemoryStorageForTests } from "@/lib/storage";
import { listAudit } from "@/server/audit/audit";
import { assertEventEditable } from "./editable";
import {
  archiveEvent,
  createEvent,
  deleteEvent,
  saveEventForm,
  scheduleResetMessage,
  setRetainData,
  updateEvent,
  updateEventSettings,
} from "./events";
import { EVENT_CHANGED_MESSAGE } from "./editable";
import { raceBeforeTransaction } from "./test-race";
import { getEvent, getEventCounts, listEvents } from "./queries";
import { getActiveRun, getRun, listRuns } from "@/server/matching/queries";
import { activateRun, startRun } from "@/server/matching/runs";
import { seedEvent } from "@/server/matching/test-seed";
import { SEND_IN_PROGRESS_MESSAGE } from "./status";

const ACTOR = "admin-test";
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  useMemoryStorageForTests();
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

  it("deletes the draft's uploaded import files after the rows, and reports keys it couldn't delete", async () => {
    const id = await makeEvent("Has uploads");
    const [upload] = await db
      .insert(imports)
      .values({ eventId: id, kind: "participants", fileKey: "pending", fileName: "Buyers.csv", status: "uploaded" })
      .returning();
    const fileKey = importFileKey(id, upload.id, "Buyers.csv");
    await putFile({ key: fileKey, body: Buffer.from("email"), contentType: "text/csv" });
    await db.update(imports).set({ fileKey }).where(eq(imports.id, upload.id));
    // A key storage refuses stands in for a delete that fails.
    await db.insert(imports).values({ eventId: id, kind: "suppliers", fileKey: "../broken", fileName: "Suppliers.csv", status: "uploaded" });

    const result = await deleteEvent(db, id, ACTOR);
    expect(result).toEqual({ ok: true, data: { id, fileErrors: ["../broken"] } });
    expect(await getFile(fileKey)).toBeNull();
    expect(await db.select().from(imports).where(eq(imports.eventId, id))).toHaveLength(0);
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

describe("compare-and-set on status (a status change between read and write)", () => {
  const lockNow = (id: string) => () => db.update(events).set({ status: "locked" }).where(eq(events.id, id));

  it("updateEvent and updateEventSettings refuse with the event-changed conflict and write nothing", async () => {
    const id = await makeEvent("Race edit");
    const before = await getEvent(id, db);
    const raced = raceBeforeTransaction(db, lockNow(id));
    const result = await updateEvent(raced, id, { name: "Renamed", eventDate: "2026-11-10", timezone: "America/Los_Angeles" }, ACTOR);
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect((await getEvent(id, db))?.name).toBe(before?.name);

    const id2 = await makeEvent("Race settings");
    const settings = await updateEventSettings(raceBeforeTransaction(db, lockNow(id2)), id2, { ...defaultEventSettings, buyerMin: 6 }, ACTOR);
    expect(settings.ok || settings.error.code).toBe("conflict");
    expect((await getEvent(id2, db))?.settings.buyerMin).toBe(defaultEventSettings.buyerMin);
    expect((await listAudit({ eventId: id2, filters: { action: "event.settings" } }, db)).total).toBe(0);
  });

  it("deleteEvent refuses when the draft moved on", async () => {
    const id = await makeEvent("Race delete");
    const raced = raceBeforeTransaction(db, () => db.update(events).set({ status: "imported" }).where(eq(events.id, id)));
    const result = await deleteEvent(raced, id, ACTOR);
    expect(result.ok || result.error.code).toBe("conflict");
    expect(await getEvent(id, db)).not.toBeNull();
  });

  it("setRetainData refuses when the event was archived in between", async () => {
    const id = await makeEvent("Race retain");
    const raced = raceBeforeTransaction(db, () => db.update(events).set({ status: "archived" }).where(eq(events.id, id)));
    const result = await setRetainData(raced, id, true, ACTOR);
    expect(result.ok || result.error.code).toBe("conflict");
    expect((await getEvent(id, db))?.settings.retainData ?? false).toBe(false);
  });
});

describe("archiveEvent", () => {
  it("archives from any status, audits it, and then every edit refuses", async () => {
    const id = await makeEvent("Archive me");
    await db.update(events).set({ status: "locked" }).where(eq(events.id, id));
    const result = await archiveEvent(db, { eventId: id, adminId: ACTOR });
    expect(result.ok).toBe(true);
    expect((await getEvent(id, db))?.status).toBe("archived");
    const audit = await listAudit({ eventId: id, filters: { action: "event.archive" } }, db);
    expect(audit.rows[0]?.before).toEqual({ status: "locked" });
    expect(audit.rows[0]?.after).toEqual({ status: "archived" });

    const edit = await updateEventSettings(db, id, defaultEventSettings, ACTOR);
    expect(edit.ok || edit.error.code).toBe("locked");
    const again = await archiveEvent(db, { eventId: id, adminId: ACTOR });
    expect(again.ok || again.error.code).toBe("conflict");
  });

  it("refuses when the status changed between read and write", async () => {
    const id = await makeEvent("Archive race");
    const raced = raceBeforeTransaction(db, () => db.update(events).set({ status: "imported" }).where(eq(events.id, id)));
    const result = await archiveEvent(raced, { eventId: id, adminId: ACTOR });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect((await getEvent(id, db))?.status).toBe("imported");
  });

  it("returns not_found for an unknown id", async () => {
    const result = await archiveEvent(db, { eventId: "00000000-0000-0000-0000-000000000000", adminId: ACTOR });
    expect(result.ok || result.error.code).toBe("not_found");
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

describe("settings writes merge into the stored settings (D95)", () => {
  it("a settings save keeps a retainData set between its read and its write", async () => {
    const id = await makeEvent("Merge retain");
    const raced = raceBeforeTransaction(db, () => setRetainData(db, id, true, ACTOR));
    const saved = await updateEventSettings(raced, id, { ...defaultEventSettings, retainData: false, buyerMin: 6 }, ACTOR);
    expect(saved.ok).toBe(true);
    expect((await getEvent(id, db))?.settings).toMatchObject({ retainData: true, buyerMin: 6 });
  });

  it("setRetainData keeps a settings save made between its read and its write", async () => {
    const id = await makeEvent("Merge settings");
    const raced = raceBeforeTransaction(db, () => updateEventSettings(db, id, { ...defaultEventSettings, buyerMin: 5 }, ACTOR));
    const saved = await setRetainData(raced, id, true, ACTOR);
    expect(saved.ok).toBe(true);
    expect((await getEvent(id, db))?.settings).toMatchObject({ retainData: true, buyerMin: 5 });
  });

  it("asks before saving fewer slots than the active run uses, naming the highest used slot", async () => {
    const seeded = await seedEvent(db, { buyers: 6 });
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!run.ok) throw new Error(run.error.message);
    const settings = (await getEvent(seeded.eventId, db))!.settings;
    const result = await updateEventSettings(db, seeded.eventId, fewerSlots(settings), ACTOR);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "needs_schedule_reset",
        message: scheduleResetMessage(settings.slotCount),
        fieldErrors: {
          slotCount: [`The active schedule uses slot ${settings.slotCount}. Keep at least ${settings.slotCount} slots, or save and clear the schedule.`],
        },
      },
    });
    expect((await getEvent(seeded.eventId, db))?.settings.slotCount).toBe(settings.slotCount);
    expect((await getActiveRun(seeded.eventId, db))?.id).toBe(run.data.runId);
    // The same count still saves.
    expect((await updateEventSettings(db, seeded.eventId, settings, ACTOR)).ok).toBe(true);
  });
});

/** The event's settings with one slot fewer, every other number kept valid. */
function fewerSlots(settings: EventSettings): EventSettings {
  const slotCount = settings.slotCount - 1;
  const buyerMax = Math.min(settings.buyerMax, slotCount);
  const buyerIdeal = Math.min(settings.buyerIdeal, buyerMax);
  return {
    ...settings,
    slotCount,
    slots: settings.slots.slice(0, -1),
    supplierTarget: Math.min(settings.supplierTarget, slotCount),
    buyerMax,
    buyerIdeal,
    buyerMin: Math.min(settings.buyerMin, buyerIdeal),
  };
}

describe("saveEventForm", () => {
  async function matchedEvent() {
    const seeded = await seedEvent(db, { buyers: 6 });
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!run.ok) throw new Error(run.error.message);
    const event = (await getEvent(seeded.eventId, db))!;
    expect(event.status).toBe("matched");
    return { ...seeded, event, runId: run.data.runId };
  }
  const details = { name: "Renamed show", eventDate: "2026-11-11", timezone: "America/Los_Angeles" };

  it("saves details and settings together", async () => {
    const { event } = await matchedEvent();
    const result = await saveEventForm(db, event.id, { details, settings: { ...event.settings, buyerMin: 2 } }, ACTOR);
    expect(result).toEqual({ ok: true, data: { id: event.id, clearedRunId: null } });
    expect(await getEvent(event.id, db)).toMatchObject({ name: "Renamed show", settings: { buyerMin: 2 } });
  });

  it("saves nothing when either part fails, with field errors keyed by form path", async () => {
    const { event } = await matchedEvent();
    const invalid = await saveEventForm(db, event.id, { details: { ...details, name: "" }, settings: { ...event.settings, mutualTopN: 0 } }, ACTOR);
    expect(!invalid.ok && Object.keys(invalid.error.fieldErrors ?? {}).sort()).toEqual(["name", "settings.mutualTopN"]);

    // Valid details with fewer slots: the settings refusal rolls the details back too.
    const refused = await saveEventForm(db, event.id, { details, settings: fewerSlots(event.settings) }, ACTOR);
    expect(!refused.ok && refused.error.code).toBe("needs_schedule_reset");
    expect(!refused.ok && Object.keys(refused.error.fieldErrors ?? {})).toEqual(["settings.slotCount"]);
    expect(await getEvent(event.id, db)).toMatchObject({ name: event.name, settings: { slotCount: event.settings.slotCount } });
    expect((await listAudit({ eventId: event.id, filters: { action: "event.update" } }, db)).total).toBe(0);
  });

  it("with clearSchedule saves fewer slots, clears the active run, and moves the event back to imported", async () => {
    const { event, runId, adminId } = await matchedEvent();
    const fewer = fewerSlots(event.settings);
    const result = await saveEventForm(db, event.id, { details, settings: fewer, clearSchedule: true }, ACTOR);
    expect(result).toEqual({ ok: true, data: { id: event.id, clearedRunId: runId } });

    const after = (await getEvent(event.id, db))!;
    expect(after).toMatchObject({ name: "Renamed show", status: "imported", settings: { slotCount: fewer.slotCount } });
    expect(await getActiveRun(event.id, db)).toBeNull();
    // The earlier run stays in the list, completed and inactive.
    expect((await listRuns(event.id, db)).map((r) => [r.id, r.status, r.isActive])).toEqual([[runId, "completed", false]]);
    const clear = await listAudit({ eventId: event.id, filters: { action: "matching.clear" } }, db);
    expect(clear.rows).toMatchObject([
      { entityId: runId, before: { activeRunId: runId, highestSlot: event.settings.slotCount }, after: { activeRunId: null, slotCount: fewer.slotCount } },
    ]);
    expect((await listAudit({ eventId: event.id, filters: { action: "event.settings" } }, db)).total).toBe(1);

    // The old run uses a slot that no longer exists, so it can't come back.
    const activate = await activateRun(db, { runId, adminId });
    expect(activate).toEqual({
      ok: false,
      error: {
        code: "validation",
        message: `This run uses slot ${event.settings.slotCount}, but the event now has ${fewer.slotCount} slots. Run matching again with the current settings, or add the slots back in Settings.`,
      },
    });
    expect(await getActiveRun(event.id, db)).toBeNull();

    // A new run uses the saved settings and becomes the schedule.
    const rerun = await startRun(db, { eventId: event.id, adminId, keepExisting: false });
    if (!rerun.ok) throw new Error(rerun.error.message);
    expect(rerun.data.isActive).toBe(true);
    expect((await getRun(rerun.data.runId, db))?.settingsSnapshot.slotCount).toBe(fewer.slotCount);
    expect((await getEvent(event.id, db))?.status).toBe("matched");
  });

  it("clears nothing when the new slot count still fits, even with clearSchedule", async () => {
    const { event, runId } = await matchedEvent();
    const result = await saveEventForm(db, event.id, { settings: { ...event.settings, buyerMin: 2 }, clearSchedule: true }, ACTOR);
    expect(result).toEqual({ ok: true, data: { id: event.id, clearedRunId: null } });
    expect((await getActiveRun(event.id, db))?.id).toBe(runId);
  });

  it("still refuses locked events, and a lock that lands first, without clearing anything", async () => {
    const { event, runId } = await matchedEvent();
    const raced = raceBeforeTransaction(db, () => db.update(events).set({ status: "locked" }).where(eq(events.id, event.id)));
    const conflict = await saveEventForm(raced, event.id, { settings: fewerSlots(event.settings), clearSchedule: true }, ACTOR);
    expect(conflict).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    const locked = await saveEventForm(db, event.id, { settings: fewerSlots(event.settings), clearSchedule: true }, ACTOR);
    expect(!locked.ok && locked.error.code).toBe("locked");
    expect((await getActiveRun(event.id, db))?.id).toBe(runId);
    expect((await listAudit({ eventId: event.id, filters: { action: "matching.clear" } }, db)).total).toBe(0);
  });
});

describe("archiveEvent while an email send is in progress", () => {
  it("refuses and leaves the status alone", async () => {
    const id = await makeEvent("Archive while sending");
    await db.update(events).set({ status: "locked" }).where(eq(events.id, id));
    const [campaign] = await db
      .insert(emailCampaigns)
      .values({
        eventId: id,
        name: "Your schedule",
        fromName: "D&A",
        fromEmail: "schedule@example.com",
        replyTo: "staff@example.com",
        subject: "Your schedule",
        htmlBody: "<p>Hi</p>",
        audience: "all",
        kind: "initial",
        status: "sending",
      })
      .returning();
    const result = await archiveEvent(db, { eventId: id, adminId: ACTOR });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: SEND_IN_PROGRESS_MESSAGE } });
    expect((await getEvent(id, db))?.status).toBe("locked");
    expect((await listAudit({ eventId: id, filters: { action: "event.archive" } }, db)).total).toBe(0);

    await db.update(emailCampaigns).set({ status: "sent" }).where(eq(emailCampaigns.id, campaign.id));
    expect((await archiveEvent(db, { eventId: id, adminId: ACTOR })).ok).toBe(true);
  });
});
