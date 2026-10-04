import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens, admins, appointments, auditEvents, events, matchRuns, rankings, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas";
import { EVENT_CHANGED_MESSAGE } from "@/server/events/editable";
import { raceBeforeTransaction } from "@/server/events/test-race";
import { displayNameFor, getParticipant, getSupplier, listParticipants, listSuppliers } from "./queries";
import {
  restoreParticipant,
  restoreSupplier,
  setBiztechOptIn,
  setSupplierDesk,
  upsertParticipant,
  upsertSupplier,
  withdrawParticipant,
  withdrawSupplier,
} from "./roster";

let db: Db;
let eventId: string;
const adminId = "admin-1";

async function createEvent(name: string, status: "draft" | "locked" = "draft"): Promise<string> {
  const [event] = await db
    .insert(events)
    .values({ name, eventDate: "2026-11-10", timezone: "America/Los_Angeles", settings: defaultEventSettings, status })
    .returning();
  return event.id;
}

const ann = {
  email: "ann@example.com",
  firstName: "Ann",
  lastName: "Lee",
  organization: "HelmsBriscoe",
  title: "Director",
  displayName: null,
  biztechOptIn: false,
};

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(admins).values({ id: adminId, name: "Admin", email: "admin@example.com" });
  eventId = await createEvent("AW 2026");
});

describe("displayNameFor", () => {
  it("mirrors 2025: Organization - Title, else the full name, unless an explicit display name is set", () => {
    expect(displayNameFor(ann)).toBe("HelmsBriscoe - Director");
    expect(displayNameFor({ ...ann, title: null })).toBe("Ann Lee");
    expect(displayNameFor({ ...ann, displayName: "Ann (HB)" })).toBe("Ann (HB)");
  });
});

describe("participants", () => {
  let annId: string;

  it("creates, lists, and reads back with status fields", async () => {
    const created = await upsertParticipant(db, { eventId, data: ann, adminId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    annId = created.data.id;

    const rows = await listParticipants(eventId, {}, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "ann@example.com", displayLabel: "HelmsBriscoe - Director", appointmentCount: 0, hasPendingToken: false });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, annId));
    expect(audit.map((a) => a.action)).toEqual(["participant.create"]);
  });

  it("returns a conflict with a field error for a duplicate email", async () => {
    const result = await upsertParticipant(db, { eventId, data: { ...ann, firstName: "Other" }, adminId });
    expect(result).toMatchObject({ ok: false, error: { code: "conflict", fieldErrors: { email: expect.any(Array) } } });
    expect(await listParticipants(eventId, {}, db)).toHaveLength(1);
  });

  it("allows the same email in another event", async () => {
    const otherEvent = await createEvent("AW 2027");
    const result = await upsertParticipant(db, { eventId: otherEvent, data: ann, adminId });
    expect(result.ok).toBe(true);
  });

  it("updates in place and revokes tokens only when the email changes", async () => {
    await db.insert(accessTokens).values({
      eventId,
      contactType: "buyer",
      entityId: annId,
      tokenHash: "hash-ann",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect((await getParticipant(annId, db))?.hasPendingToken).toBe(true);

    const sameEmail = await upsertParticipant(db, { eventId, id: annId, data: { ...ann, title: "VP" }, adminId });
    expect(sameEmail.ok).toBe(true);
    expect((await getParticipant(annId, db))?.hasPendingToken).toBe(true);

    const newEmail = await upsertParticipant(db, { eventId, id: annId, data: { ...ann, email: "ann.lee@example.com" }, adminId });
    expect(newEmail.ok).toBe(true);
    const after = await getParticipant(annId, db);
    expect(after?.email).toBe("ann.lee@example.com");
    expect(after?.hasPendingToken).toBe(false);
    const [token] = await db.select().from(accessTokens).where(eq(accessTokens.entityId, annId));
    expect(token.revokedAt).not.toBeNull();

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, annId));
    const update = audit.find((a) => a.note?.includes("revoked"));
    expect(update?.before).toMatchObject({ email: "ann@example.com" });
    expect(update?.after).toMatchObject({ email: "ann.lee@example.com" });
  });

  it("refuses to edit a participant from another event", async () => {
    const otherEvent = await createEvent("AW 2028");
    const result = await upsertParticipant(db, { eventId: otherEvent, id: annId, data: ann, adminId });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("withdraws without deleting rankings or appointments, then restores", async () => {
    const [supplier] = await db.insert(suppliers).values({ eventId, name: "eShow", type: "business" }).returning();
    await db.insert(rankings).values({ eventId, rankerType: "buyer", rankerId: annId, targetType: "supplier", targetId: supplier.id, rank: 1 });
    const [run] = await db.insert(matchRuns).values({ eventId, status: "completed", settingsSnapshot: defaultEventSettings, isActive: true }).returning();
    await db.insert(appointments).values({ runId: run.id, eventId, slot: 1, buyerId: annId, supplierId: supplier.id, source: "engine" });

    const withdrawn = await withdrawParticipant(db, { id: annId, adminId });
    expect(withdrawn.ok).toBe(true);
    expect(await listParticipants(eventId, {}, db)).toHaveLength(0);
    const all = await listParticipants(eventId, { includeWithdrawn: true }, db);
    expect(all[0]).toMatchObject({ status: "withdrawn", appointmentCount: 1 });
    expect(await db.select().from(rankings).where(eq(rankings.rankerId, annId))).toHaveLength(1);
    expect(await db.select().from(appointments).where(eq(appointments.buyerId, annId))).toHaveLength(1);

    const again = await withdrawParticipant(db, { id: annId, adminId });
    expect(again.ok).toBe(true);

    const restored = await restoreParticipant(db, { id: annId, adminId });
    expect(restored.ok).toBe(true);
    expect((await getParticipant(annId, db))?.status).toBe("active");

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, annId));
    expect(audit.map((a) => a.action)).toContain("participant.withdraw");
    expect(audit.map((a) => a.action)).toContain("participant.restore");
    expect(audit.filter((a) => a.action === "participant.withdraw")).toHaveLength(1);
  });

  it("flips biztech opt-in", async () => {
    const result = await setBiztechOptIn(db, { id: annId, optIn: true, adminId });
    expect(result.ok).toBe(true);
    expect((await getParticipant(annId, db))?.biztechOptIn).toBe(true);
  });

  it("reports not_found for unknown ids", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    expect(await withdrawParticipant(db, { id: missing, adminId })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await getParticipant(missing, db)).toBeNull();
  });
});

describe("suppliers", () => {
  let hyattId: string;
  const hyatt = {
    name: "Hyatt Regency Monterey",
    type: "hotel" as const,
    deskNumber: null,
    deskOverride: false,
    adminContact: { name: "Pat", email: "pat@hyatt.com" },
    attendeeContact: { name: "Sam", email: "sam@hyatt.com" },
  };

  it("creates with flattened contacts and rejects duplicate names", async () => {
    const created = await upsertSupplier(db, { eventId, data: hyatt, adminId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    hyattId = created.data.id;
    const row = await getSupplier(hyattId, db);
    expect(row).toMatchObject({ adminContactEmail: "pat@hyatt.com", attendeeContactName: "Sam", appointmentCount: 0, hasPendingToken: false });

    const duplicate = await upsertSupplier(db, { eventId, data: hyatt, adminId });
    expect(duplicate).toMatchObject({ ok: false, error: { code: "conflict", fieldErrors: { name: expect.any(Array) } } });
  });

  it("revokes only the link whose contact email changed", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(accessTokens).values([
      { eventId, contactType: "supplier_admin", entityId: hyattId, tokenHash: "hash-admin", expiresAt },
      { eventId, contactType: "supplier_attendee", entityId: hyattId, tokenHash: "hash-attendee", expiresAt },
    ]);
    const result = await upsertSupplier(db, {
      eventId,
      id: hyattId,
      data: { ...hyatt, attendeeContact: { name: "Sam", email: "sam.new@hyatt.com" } },
      adminId,
    });
    expect(result.ok).toBe(true);
    const tokens = await db.select().from(accessTokens).where(eq(accessTokens.entityId, hyattId));
    expect(tokens.find((t) => t.contactType === "supplier_admin")?.revokedAt).toBeNull();
    expect(tokens.find((t) => t.contactType === "supplier_attendee")?.revokedAt).not.toBeNull();
    expect((await getSupplier(hyattId, db))?.hasPendingToken).toBe(true);
  });

  it("sets and clears a desk override and refuses a taken desk", async () => {
    const other = await upsertSupplier(db, { eventId, data: { ...hyatt, name: "Visit SLO CAL", adminContact: null, attendeeContact: null }, adminId });
    if (!other.ok) throw new Error("setup");
    expect((await setSupplierDesk(db, { id: other.data.id, deskNumber: 4, adminId })).ok).toBe(true);

    const taken = await setSupplierDesk(db, { id: hyattId, deskNumber: 4, adminId });
    expect(taken).toMatchObject({ ok: false, error: { code: "conflict", fieldErrors: { deskNumber: expect.any(Array) } } });

    expect((await setSupplierDesk(db, { id: hyattId, deskNumber: 7, adminId })).ok).toBe(true);
    expect(await getSupplier(hyattId, db)).toMatchObject({ deskNumber: 7, deskOverride: true });
    expect((await setSupplierDesk(db, { id: hyattId, deskNumber: null, adminId })).ok).toBe(true);
    expect(await getSupplier(hyattId, db)).toMatchObject({ deskNumber: null, deskOverride: false });
  });

  it("saves a desk with the supplier: a new number is an override, the same number is left alone", async () => {
    const [slo] = await listSuppliers(eventId, {}, db).then((rows) => rows.filter((s) => s.name === "Visit SLO CAL"));
    const taken = await upsertSupplier(db, { eventId, id: hyattId, data: { ...hyatt, deskNumber: 4 }, adminId });
    expect(taken).toMatchObject({ ok: false, error: { code: "conflict", fieldErrors: { deskNumber: expect.any(Array) } } });

    expect((await upsertSupplier(db, { eventId, id: hyattId, data: { ...hyatt, deskNumber: 9 }, adminId })).ok).toBe(true);
    expect(await getSupplier(hyattId, db)).toMatchObject({ deskNumber: 9, deskOverride: true });

    // A desk assigned at lock (no override) survives an edit that sends the same number back.
    await db.update(suppliers).set({ deskNumber: 4, deskOverride: false }).where(eq(suppliers.id, slo.id));
    const sloData = { ...hyatt, name: "Visit SLO CAL", adminContact: null, attendeeContact: null, deskNumber: 4 };
    expect((await upsertSupplier(db, { eventId, id: slo.id, data: sloData, adminId })).ok).toBe(true);
    expect(await getSupplier(slo.id, db)).toMatchObject({ deskNumber: 4, deskOverride: false });

    expect((await upsertSupplier(db, { eventId, id: hyattId, data: { ...hyatt, deskNumber: null }, adminId })).ok).toBe(true);
    expect(await getSupplier(hyattId, db)).toMatchObject({ deskNumber: null, deskOverride: false });
    const untouched = await upsertSupplier(db, { eventId, id: slo.id, data: { ...sloData, deskNumber: undefined }, adminId });
    expect(untouched.ok).toBe(true);
    expect(await getSupplier(slo.id, db)).toMatchObject({ deskNumber: 4 });
  });

  it("withdraws and restores, hiding withdrawn rows by default", async () => {
    expect((await withdrawSupplier(db, { id: hyattId, adminId })).ok).toBe(true);
    expect((await listSuppliers(eventId, {}, db)).map((s) => s.name)).toEqual(["eShow", "Visit SLO CAL"]);
    expect(await listSuppliers(eventId, { includeWithdrawn: true }, db)).toHaveLength(3);
    expect((await restoreSupplier(db, { id: hyattId, adminId })).ok).toBe(true);
    expect(await listSuppliers(eventId, {}, db)).toHaveLength(3);
  });
});

describe("locked events", () => {
  it("refuse every roster change", async () => {
    const lockedEvent = await createEvent("Locked", "locked");
    const [person] = await db
      .insert(suppliers)
      .values({ eventId: lockedEvent, name: "Frozen Inn", type: "hotel" })
      .returning();
    const results = await Promise.all([
      upsertParticipant(db, { eventId: lockedEvent, data: ann, adminId }),
      upsertSupplier(db, { eventId: lockedEvent, data: { name: "New", type: "hotel", deskOverride: false }, adminId }),
      withdrawSupplier(db, { id: person.id, adminId }),
      setSupplierDesk(db, { id: person.id, deskNumber: 1, adminId }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "locked" } });
    }
  });
});

describe("editability under the event row lock (D85)", () => {
  it("a withdraw refuses when the event was locked after its check, and writes nothing", async () => {
    const event = await createEvent("Race withdraw");
    const [person] = await db.insert(suppliers).values({ eventId: event, name: "Late Lodge", type: "hotel" }).returning();
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, event));
    const result = await withdrawSupplier(raceBeforeTransaction(db, lock), { id: person.id, adminId });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect((await getSupplier(person.id, db))?.status).toBe("active");
    expect(await db.select().from(auditEvents).where(eq(auditEvents.entityId, person.id))).toHaveLength(0);
  });
});

describe("restoring a supplier whose desk was taken", () => {
  it("clears the desk and says so in the result and the audit note", async () => {
    const event = await createEvent("Desk restore");
    const [gone] = await db
      .insert(suppliers)
      .values({ eventId: event, name: "Gone Inn", type: "hotel", deskNumber: 5, deskOverride: true })
      .returning();
    expect((await withdrawSupplier(db, { id: gone.id, adminId })).ok).toBe(true);
    const [taker] = await db.insert(suppliers).values({ eventId: event, name: "New Inn", type: "hotel" }).returning();
    expect((await setSupplierDesk(db, { id: taker.id, deskNumber: 5, adminId })).ok).toBe(true);

    const note = "Desk 5 is now assigned to New Inn, so the desk was cleared. Reassign desks or set one by hand.";
    expect(await restoreSupplier(db, { id: gone.id, adminId })).toEqual({ ok: true, data: { id: gone.id, note } });
    expect(await getSupplier(gone.id, db)).toMatchObject({ status: "active", deskNumber: null, deskOverride: false });
    expect(await getSupplier(taker.id, db)).toMatchObject({ deskNumber: 5, deskOverride: true });
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "supplier.restore"), eq(auditEvents.entityId, gone.id)));
    expect(audit).toMatchObject({
      entityId: gone.id,
      note,
      before: { status: "withdrawn", deskNumber: 5, deskOverride: true },
      after: { status: "active", deskNumber: null, deskOverride: false },
    });

    // A desk nobody took comes back with the supplier.
    const [kept] = await db
      .insert(suppliers)
      .values({ eventId: event, name: "Kept Inn", type: "hotel", deskNumber: 8, deskOverride: true })
      .returning();
    await withdrawSupplier(db, { id: kept.id, adminId });
    expect(await restoreSupplier(db, { id: kept.id, adminId })).toEqual({ ok: true, data: { id: kept.id } });
    expect(await getSupplier(kept.id, db)).toMatchObject({ deskNumber: 8, deskOverride: true });
  });
});
