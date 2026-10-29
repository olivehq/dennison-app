import { and, desc, eq, isNull, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens, admins, appointments, auditEvents, events, matchRuns, participants, rankings, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas";
import { recipientKey } from "@/lib/schemas/email";
import { raceBeforeTransaction } from "@/server/events/test-race";
import { decryptToken } from "@/lib/tokens";
import { issueTokenForContact, linksForContacts, revokeToken, verifyToken } from "@/server/tokens/tokens";
import { displayNameFor, getParticipant, getSupplier, listParticipants, listSuppliers } from "./queries";
import {
  restoreParticipant,
  restoreSupplier,
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
    expect(rows[0]).toMatchObject({ email: "ann@example.com", displayLabel: "HelmsBriscoe - Director", appointmentCount: 0 });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, annId));
    expect(audit.map((a) => a.action)).toEqual(["participant.create"]);
  });

  it("returns a conflict with a field error for a duplicate email", async () => {
    const result = await upsertParticipant(db, { eventId, data: { ...ann, firstName: "Other" }, adminId });
    expect(result).toMatchObject({ ok: false, error: { code: "conflict", fieldErrors: { email: expect.any(Array) } } });
    expect(await listParticipants(eventId, {}, db)).toHaveLength(1);
  });

  it("checks the email under the event lock, so a participant added meanwhile is seen", async () => {
    const event = await createEvent("Participant email race");
    const between = async () => {
      await db.insert(participants).values({ eventId: event, email: ann.email, firstName: "Ann", lastName: "Lee" });
    };
    const result = await upsertParticipant(raceBeforeTransaction(db, between), { eventId: event, data: ann, adminId });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "conflict",
        message: "Another participant in this event already uses that email.",
        fieldErrors: { email: ["Already used by another participant."] },
      },
    });
    expect(await listParticipants(event, {}, db)).toHaveLength(1);
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
    const sameEmail = await upsertParticipant(db, { eventId, id: annId, data: { ...ann, title: "VP", biztechOptIn: true }, adminId });
    expect(sameEmail.ok).toBe(true);
    expect(await getParticipant(annId, db)).toMatchObject({ title: "VP", biztechOptIn: true });
    const [kept] = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, "hash-ann"));
    expect(kept.revokedAt).toBeNull();

    const newEmail = await upsertParticipant(db, { eventId, id: annId, data: { ...ann, email: "ann.lee@example.com" }, adminId });
    expect(newEmail.ok).toBe(true);
    const after = await getParticipant(annId, db);
    expect(after?.email).toBe("ann.lee@example.com");
    // The old link is revoked and the new address already has its own (see the reissue tests below).
    const [token] = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, "hash-ann"));
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
    expect(row).toMatchObject({ adminContactEmail: "pat@hyatt.com", attendeeContactName: "Sam", appointmentCount: 0 });

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
    expect(tokens.find((t) => t.tokenHash === "hash-admin")?.revokedAt).toBeNull();
    expect(tokens.find((t) => t.tokenHash === "hash-attendee")?.revokedAt).not.toBeNull();
  });

  it("saves a desk with the supplier: a new number is an override, the same number is left alone", async () => {
    const created = await upsertSupplier(db, {
      eventId,
      data: { ...hyatt, name: "Visit SLO CAL", adminContact: null, attendeeContact: null, deskNumber: 4 },
      adminId,
    });
    if (!created.ok) throw new Error("setup");
    const slo = { id: created.data.id };
    expect(await getSupplier(slo.id, db)).toMatchObject({ deskNumber: 4, deskOverride: true });
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
    expect(result).toEqual({ ok: false, error: { code: "locked", message: "The schedule is locked. Unlock it on the Schedule page to make changes." } });
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
    const [taker] = await db
      .insert(suppliers)
      .values({ eventId: event, name: "New Inn", type: "hotel", deskNumber: 5, deskOverride: true })
      .returning();

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

describe("a save that read the row before another save landed", () => {
  const expiresAt = () => new Date(Date.now() + 86_400_000);

  it("compares a participant's email with the row as it is now, so the new contact's link is revoked", async () => {
    const event = await createEvent("Stale participant save");
    const created = await upsertParticipant(db, { eventId: event, data: ann, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;

    // Another admin changes A to B and issues B a link after this save read A.
    const between = async () => {
      const moved = await upsertParticipant(db, { eventId: event, id, data: { ...ann, email: "b@example.com" }, adminId });
      if (!moved.ok) throw new Error("setup");
      await db.insert(accessTokens).values({ eventId: event, contactType: "buyer", entityId: id, tokenHash: "hash-stale-b", expiresAt: expiresAt() });
    };
    const stale = await upsertParticipant(raceBeforeTransaction(db, between), { eventId: event, id, data: ann, adminId });
    expect(stale.ok).toBe(true);

    expect((await getParticipant(id, db))?.email).toBe("ann@example.com");
    const [token] = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, "hash-stale-b"));
    expect(token.revokedAt).not.toBeNull();
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, id), like(auditEvents.note, "Email changed; 1 link revoked.%")));
    expect(audit.before).toMatchObject({ email: "b@example.com" });
    expect(audit.after).toMatchObject({ email: "ann@example.com" });
  });

  it("compares supplier contact emails with the row as it is now, so the new contact's link is revoked", async () => {
    const event = await createEvent("Stale supplier save");
    const inn = {
      name: "Stale Inn",
      type: "hotel" as const,
      deskOverride: false,
      adminContact: { name: "Pat", email: "a@inn.com" },
      attendeeContact: { name: "Sam", email: "sam@inn.com" },
    };
    const created = await upsertSupplier(db, { eventId: event, data: inn, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;

    const between = async () => {
      const moved = await upsertSupplier(db, { eventId: event, id, data: { ...inn, adminContact: { name: "Pat", email: "b@inn.com" } }, adminId });
      if (!moved.ok) throw new Error("setup");
      await db.insert(accessTokens).values([
        { eventId: event, contactType: "supplier_admin", entityId: id, tokenHash: "hash-stale-admin-b", expiresAt: expiresAt() },
        { eventId: event, contactType: "supplier_attendee", entityId: id, tokenHash: "hash-stale-attendee", expiresAt: expiresAt() },
      ]);
    };
    const stale = await upsertSupplier(raceBeforeTransaction(db, between), { eventId: event, id, data: inn, adminId });
    expect(stale.ok).toBe(true);

    expect((await getSupplier(id, db))?.adminContactEmail).toBe("a@inn.com");
    const tokens = await db.select().from(accessTokens).where(eq(accessTokens.entityId, id));
    expect(tokens.find((t) => t.tokenHash === "hash-stale-admin-b")?.revokedAt).not.toBeNull();
    expect(tokens.find((t) => t.tokenHash === "hash-stale-attendee")?.revokedAt).toBeNull();
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, id), like(auditEvents.note, "Contact email changed; 1 link revoked.%")));
    expect(audit.before).toMatchObject({ adminContactEmail: "b@inn.com" });
  });
});

describe("supplier names that differ only in case", () => {
  const inn = { name: "Audit Supplier", type: "hotel" as const, deskOverride: false };
  const nameConflict = {
    ok: false,
    error: {
      code: "conflict",
      message: "Another supplier in this event already has that name.",
      fieldErrors: { name: ["Already used by another supplier."] },
    },
  };

  it("are refused on add and on edit, but a supplier can recase its own name", async () => {
    const event = await createEvent("Supplier name case");
    const first = await upsertSupplier(db, { eventId: event, data: inn, adminId });
    const second = await upsertSupplier(db, { eventId: event, data: { ...inn, name: "Other Supplier" }, adminId });
    if (!first.ok || !second.ok) throw new Error("setup");

    expect(await upsertSupplier(db, { eventId: event, data: { ...inn, name: "audit supplier" }, adminId })).toEqual(nameConflict);
    expect(await upsertSupplier(db, { eventId: event, id: second.data.id, data: { ...inn, name: "AUDIT SUPPLIER" }, adminId })).toEqual(
      nameConflict,
    );
    expect((await getSupplier(second.data.id, db))?.name).toBe("Other Supplier");

    expect((await upsertSupplier(db, { eventId: event, id: first.data.id, data: { ...inn, name: "Audit supplier" }, adminId })).ok).toBe(true);
    expect((await getSupplier(first.data.id, db))?.name).toBe("Audit supplier");
    expect(await listSuppliers(event, {}, db)).toHaveLength(2);

    // Another event may use the same name.
    expect((await upsertSupplier(db, { eventId: await createEvent("Other event"), data: inn, adminId })).ok).toBe(true);
  });

  it("are checked under the event lock, so a supplier added meanwhile is seen", async () => {
    const event = await createEvent("Supplier name race");
    const between = async () => {
      await db.insert(suppliers).values({ eventId: event, name: "Audit Supplier", type: "hotel" });
    };
    const result = await upsertSupplier(raceBeforeTransaction(db, between), {
      eventId: event,
      data: { ...inn, name: "audit supplier" },
      adminId,
    });
    expect(result).toEqual(nameConflict);
    expect(await listSuppliers(event, {}, db)).toHaveLength(1);
  });

  it("are rejected by the database, past the code check", async () => {
    const event = await createEvent("Supplier name index");
    await db.insert(suppliers).values({ eventId: event, name: "Audit Supplier", type: "hotel" });
    await expect(db.insert(suppliers).values({ eventId: event, name: "AUDIT supplier", type: "business" })).rejects.toThrow();
    expect(await listSuppliers(event, {}, db)).toHaveLength(1);
  });
});

describe("changing a contact's email while their link is live", () => {
  const expiresAt = () => new Date(Date.now() + 86_400_000);
  const pastDate = () => new Date(Date.now() - 86_400_000);
  const inn = {
    name: "Reissue Inn",
    type: "hotel" as const,
    deskOverride: false,
    adminContact: { name: "Pat", email: "pat@inn.com" },
    attendeeContact: { name: "Sam", email: "sam@inn.com" },
  };

  async function liveTokens(entityId: string) {
    return db.select().from(accessTokens).where(and(eq(accessTokens.entityId, entityId), isNull(accessTokens.revokedAt)));
  }

  function plainToken(row: { tokenCiphertext: string | null } | undefined): string {
    const plain = row?.tokenCiphertext ? decryptToken(row.tokenCiphertext) : null;
    if (!plain) throw new Error("expected a stored token");
    return plain;
  }

  async function updateAudit(entityId: string, action: "participant.update" | "supplier.update") {
    const [row] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, entityId), eq(auditEvents.action, action)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    return row;
  }

  it("revokes a participant's old link and issues one for the new address", async () => {
    const event = await createEvent("Participant email reissue");
    const created = await upsertParticipant(db, { eventId: event, data: ann, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    const old = await issueTokenForContact(db, { eventId: event, contactType: "buyer", entityId: id, expiresAt: expiresAt() });

    const result = await upsertParticipant(db, { eventId: event, id, data: { ...ann, email: "ann.new@example.com" }, adminId });
    expect(result.ok).toBe(true);

    expect(await verifyToken(db, old.token)).toBeNull();
    const [fresh] = await liveTokens(id);
    expect(fresh.id).not.toBe(old.tokenId);
    expect(await verifyToken(db, plainToken(fresh))).toMatchObject({ contactType: "buyer", entityId: id });
    expect(await updateAudit(id, "participant.update")).toMatchObject({
      after: { email: "ann.new@example.com", linksReissued: ["buyer"] },
      note: "Email changed; 1 link revoked. A new link was issued for the new address.",
    });
  });

  it("does the same for a supplier admin contact and leaves the other contact's link", async () => {
    const event = await createEvent("Supplier email reissue");
    const created = await upsertSupplier(db, { eventId: event, data: inn, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    const admin = await issueTokenForContact(db, { eventId: event, contactType: "supplier_admin", entityId: id, expiresAt: expiresAt() });
    const attendee = await issueTokenForContact(db, { eventId: event, contactType: "supplier_attendee", entityId: id, expiresAt: expiresAt() });

    const result = await upsertSupplier(db, { eventId: event, id, data: { ...inn, adminContact: { name: "Pat", email: "pat.new@inn.com" } }, adminId });
    expect(result.ok).toBe(true);

    expect(await verifyToken(db, admin.token)).toBeNull();
    expect(await verifyToken(db, attendee.token)).toMatchObject({ contactType: "supplier_attendee" });
    const live = await liveTokens(id);
    expect(live).toHaveLength(2);
    const fresh = live.find((t) => t.contactType === "supplier_admin");
    expect(fresh?.id).not.toBe(admin.tokenId);
    expect(await verifyToken(db, plainToken(fresh))).toMatchObject({ contactType: "supplier_admin", entityId: id });
    expect(await updateAudit(id, "supplier.update")).toMatchObject({
      after: { adminContactEmail: "pat.new@inn.com", linksReissued: ["supplier_admin"] },
      note: "Contact email changed; 1 link revoked. A new link was issued for the new address.",
    });
  });

  it("does not issue a link when an admin had already revoked the old one", async () => {
    const event = await createEvent("Revoked before email edit");
    const created = await upsertParticipant(db, { eventId: event, data: ann, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    const old = await issueTokenForContact(db, { eventId: event, contactType: "buyer", entityId: id, expiresAt: expiresAt() });
    expect((await revokeToken(db, old.tokenId, adminId)).ok).toBe(true);

    const result = await upsertParticipant(db, { eventId: event, id, data: { ...ann, email: "ann.new@example.com" }, adminId });
    expect(result.ok).toBe(true);

    expect(await liveTokens(id)).toHaveLength(0);
    const audit = await updateAudit(id, "participant.update");
    expect(audit.after).not.toHaveProperty("linksReissued");
    expect(audit.note).toBe("Email changed; 0 links revoked.");
  });

  it("does not issue a link when the old one had expired", async () => {
    const event = await createEvent("Expired before email edit");
    const created = await upsertParticipant(db, { eventId: event, data: ann, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    await db.insert(accessTokens).values({ eventId: event, contactType: "buyer", entityId: id, tokenHash: "hash-expired", expiresAt: pastDate() });

    const result = await upsertParticipant(db, { eventId: event, id, data: { ...ann, email: "ann.new@example.com" }, adminId });
    expect(result.ok).toBe(true);
    expect(await liveTokens(id)).toHaveLength(1);
    // Still expired, not revoked, so a send or the access list can give the new address a link.
    const [row] = await db.select().from(accessTokens).where(eq(accessTokens.entityId, id));
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("ends a cleared contact's link without revoking it, so a later address can get a link", async () => {
    const event = await createEvent("Cleared contact email");
    const created = await upsertSupplier(db, { eventId: event, data: inn, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    const old = await issueTokenForContact(db, { eventId: event, contactType: "supplier_attendee", entityId: id, expiresAt: expiresAt() });

    const cleared = await upsertSupplier(db, { eventId: event, id, data: { ...inn, attendeeContact: undefined }, adminId });
    expect(cleared.ok).toBe(true);

    expect(await verifyToken(db, old.token)).toBeNull();
    const [ended] = await db.select().from(accessTokens).where(eq(accessTokens.id, old.tokenId));
    expect(ended.revokedAt).toBeNull();
    const audit = await updateAudit(id, "supplier.update");
    expect(audit.after).not.toHaveProperty("linksReissued");
    expect(audit.note).toBe("Contact email changed; 0 links revoked. 1 link expired because the email was removed.");

    // A later save sets a new address: the contact is not treated as revoked (D137).
    const reset = await upsertSupplier(db, { eventId: event, id, data: { ...inn, attendeeContact: { name: "Sam", email: "sam.new@inn.com" } }, adminId });
    expect(reset.ok).toBe(true);
    const contact = { contactType: "supplier_attendee" as const, entityId: id };
    const links = await linksForContacts(db, event, [contact], { issueMissing: true });
    if (!links.ok) throw new Error(links.error.message);
    expect(links.data.revoked.size).toBe(0);
    const link = links.data.links.get(recipientKey(contact.contactType, contact.entityId));
    expect(link?.tokenId).not.toBe(old.tokenId);
    expect(await verifyToken(db, link!.token)).toMatchObject({ contactType: "supplier_attendee", entityId: id });
  });
});

describe("withdraw and restore leave links alone (D130)", () => {
  const expiresAt = () => new Date(Date.now() + 86_400_000);

  async function liveTokens(entityId: string) {
    return db.select().from(accessTokens).where(and(eq(accessTokens.entityId, entityId), isNull(accessTokens.revokedAt)));
  }

  async function restoreAudit(entityId: string) {
    const [row] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, entityId), like(auditEvents.action, "%.restore")))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    return row;
  }

  it("keeps a participant's live link through withdraw and restore", async () => {
    const event = await createEvent("Restore keeps link");
    const created = await upsertParticipant(db, { eventId: event, data: ann, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    const link = await issueTokenForContact(db, { eventId: event, contactType: "buyer", entityId: id, expiresAt: expiresAt() });

    await withdrawParticipant(db, { id, adminId });
    expect((await liveTokens(id)).map((t) => t.id)).toEqual([link.tokenId]);
    expect((await restoreParticipant(db, { id, adminId })).ok).toBe(true);
    expect((await liveTokens(id)).map((t) => t.id)).toEqual([link.tokenId]);
    expect((await verifyToken(db, link.token))?.entityId).toBe(id);
    expect(await restoreAudit(id)).toMatchObject({ after: { status: "active" }, note: null });
  });

  it("keeps a link revoked while the participant was withdrawn revoked after restore", async () => {
    const event = await createEvent("Restore keeps revoke");
    const created = await upsertParticipant(db, { eventId: event, data: ann, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    const link = await issueTokenForContact(db, { eventId: event, contactType: "buyer", entityId: id, expiresAt: expiresAt() });

    await withdrawParticipant(db, { id, adminId });
    expect((await revokeToken(db, link.tokenId, adminId)).ok).toBe(true);
    expect((await restoreParticipant(db, { id, adminId })).ok).toBe(true);

    expect(await liveTokens(id)).toHaveLength(0);
    expect(await verifyToken(db, link.token)).toBeNull();
    const audit = await restoreAudit(id);
    expect(audit).toMatchObject({ after: { status: "active" }, note: null });
    expect(audit.after).not.toHaveProperty("linksReissued");
  });

  it("leaves a link revoked before the withdrawal alone", async () => {
    const event = await createEvent("Restore respects earlier revoke");
    const created = await upsertParticipant(db, { eventId: event, data: ann, adminId });
    if (!created.ok) throw new Error("setup");
    const id = created.data.id;
    const link = await issueTokenForContact(db, { eventId: event, contactType: "buyer", entityId: id, expiresAt: expiresAt() });

    expect((await revokeToken(db, link.tokenId, adminId)).ok).toBe(true);
    await withdrawParticipant(db, { id, adminId });
    expect((await restoreParticipant(db, { id, adminId })).ok).toBe(true);
    expect(await liveTokens(id)).toHaveLength(0);
    expect(await restoreAudit(id)).toMatchObject({ after: { status: "active" }, note: null });
  });

  it("restores a supplier without reissuing a contact link revoked while withdrawn", async () => {
    const event = await createEvent("Supplier restore keeps revoke");
    const [inn] = await db
      .insert(suppliers)
      .values({
        eventId: event,
        name: "Relink Inn",
        type: "hotel",
        deskNumber: 3,
        deskOverride: true,
        adminContactEmail: "pat@relink.com",
        attendeeContactEmail: "sam@relink.com",
      })
      .returning();
    const admin = await issueTokenForContact(db, { eventId: event, contactType: "supplier_admin", entityId: inn.id, expiresAt: expiresAt() });
    const attendee = await issueTokenForContact(db, {
      eventId: event,
      contactType: "supplier_attendee",
      entityId: inn.id,
      expiresAt: expiresAt(),
    });

    await withdrawSupplier(db, { id: inn.id, adminId });
    expect((await revokeToken(db, admin.tokenId, adminId)).ok).toBe(true);
    await db.insert(suppliers).values({ eventId: event, name: "Taker Inn", type: "hotel", deskNumber: 3, deskOverride: true });
    const restored = await restoreSupplier(db, { id: inn.id, adminId });
    expect(restored.ok).toBe(true);

    expect((await liveTokens(inn.id)).map((t) => t.id)).toEqual([attendee.tokenId]);
    const audit = await restoreAudit(inn.id);
    expect(audit).toMatchObject({
      after: { status: "active", deskNumber: null },
      note: "Desk 3 is now assigned to Taker Inn, so the desk was cleared. Reassign desks or set one by hand.",
    });
    expect(audit.after).not.toHaveProperty("linksReissued");
  });
});
