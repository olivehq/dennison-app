import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens, appointments, participants, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { recordQueries } from "@/server/events/test-race";
import { loadParticipantView } from "@/server/exports/participant";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { issueTokenForContact } from "@/server/tokens/tokens";
import {
  isLive,
  loadActiveSchedule,
  loadPersonSchedule,
  participantSlots,
  type PersonRef,
  type ScheduleSnapshot,
} from "./snapshot";
import { getScheduleView } from "./views";

/**
 * Two buyers, two suppliers, three slots. Gone Org withdrew after matching
 * and still holds slot 3 at the Hilton; Gone Hotel withdrew and still holds
 * slot 2 with Acme.
 */
const snapshot: ScheduleSnapshot = {
  slots: [
    { slot: 1, start: "3:10 PM", end: "3:20 PM" },
    { slot: 2, start: "3:21 PM", end: "3:31 PM" },
    { slot: 3, start: "3:32 PM", end: "3:42 PM" },
  ],
  buyers: [
    { id: "b-acme", name: "Acme, Inc - Director", withdrawn: false },
    { id: "b-zed", name: "Zed Org - Planner", withdrawn: false },
    { id: "b-gone", name: "Gone Org - Planner", withdrawn: true },
  ],
  suppliers: [
    { id: "s-hotel", name: "Hilton", desk: 12, withdrawn: false },
    { id: "s-biz", name: "eShow", desk: null, withdrawn: false },
    { id: "s-gone", name: "Gone Hotel", desk: 14, withdrawn: true },
  ],
  appointments: [
    { slot: 1, buyerId: "b-acme", supplierId: "s-hotel" },
    { slot: 3, buyerId: "b-acme", supplierId: "s-biz" },
    { slot: 1, buyerId: "b-zed", supplierId: "s-biz" },
    { slot: 2, buyerId: "b-zed", supplierId: "s-hotel" },
    { slot: 3, buyerId: "b-gone", supplierId: "s-hotel" },
    { slot: 2, buyerId: "b-acme", supplierId: "s-gone" },
  ],
};

describe("participantSlots", () => {
  it("gives a buyer every slot in order with the supplier's name and desk, OPEN when empty", () => {
    const one = { ...snapshot, appointments: snapshot.appointments.slice(0, 1) };
    expect(participantSlots(one, { type: "buyer", id: "b-acme" })).toEqual([
      { slot: 1, start: "3:10 PM", end: "3:20 PM", appointment: { counterpartId: "s-hotel", counterpartName: "Hilton", desk: 12 } },
      { slot: 2, start: "3:21 PM", end: "3:31 PM", appointment: null },
      { slot: 3, start: "3:32 PM", end: "3:42 PM", appointment: null },
    ]);
  });

  it("gives a supplier the buyer's name and its own desk, or none before desks are assigned", () => {
    const hotel = participantSlots(snapshot, { type: "supplier", id: "s-hotel" });
    expect(hotel.map((s) => s.appointment)).toEqual([
      { counterpartId: "b-acme", counterpartName: "Acme, Inc - Director", desk: 12 },
      { counterpartId: "b-zed", counterpartName: "Zed Org - Planner", desk: 12 },
      null,
    ]);
    const biz = participantSlots(snapshot, { type: "supplier", id: "s-biz" });
    expect(biz.map((s) => (s.appointment ? s.appointment.desk : "open"))).toEqual([null, "open", null]);
  });

  it("shows a meeting with someone who withdrew as OPEN, on both sides", () => {
    // The Hilton's slot 3 is Gone Org; Acme's slot 2 is Gone Hotel.
    expect(participantSlots(snapshot, { type: "supplier", id: "s-hotel" })[2].appointment).toBeNull();
    expect(participantSlots(snapshot, { type: "buyer", id: "b-acme" })[1].appointment).toBeNull();
    expect(isLive(snapshot, { buyerId: "b-gone", supplierId: "s-hotel" })).toBe(false);
    expect(isLive(snapshot, { buyerId: "b-acme", supplierId: "s-gone" })).toBe(false);
    expect(isLive(snapshot, { buyerId: "b-acme", supplierId: "s-hotel" })).toBe(true);
  });

  it("gives a person with no meetings, or one not in the snapshot, all OPEN", () => {
    for (const ref of [{ type: "buyer", id: "b-nobody" }, { type: "supplier", id: "b-acme" }] satisfies PersonRef[]) {
      expect(participantSlots(snapshot, ref).every((s) => s.appointment === null)).toBe(true);
    }
  });

  it("carries no rank fields", () => {
    const withRanks = {
      ...snapshot,
      appointments: snapshot.appointments.map((a) => ({ ...a, buyerRank: 1, supplierRank: 2 })),
    };
    const json = JSON.stringify(participantSlots(withRanks, { type: "buyer", id: "b-acme" }));
    expect(json).not.toMatch(/rank|strength/i);
  });
});

describe("loading the active schedule", () => {
  let db: Db;
  let seeded: Seeded;

  beforeAll(async () => {
    db = await createTestDb();
    seeded = await seedEvent(db);
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!run.ok) throw new Error(run.error.message);
    // Withdrawn after matching, so their meetings stay on the run.
    const [meeting] = await db.select().from(appointments).where(eq(appointments.eventId, seeded.eventId)).limit(1);
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, meeting.buyerId));
    const otherSupplier = seeded.suppliers.find((s) => s.id !== meeting.supplierId)!;
    await db.update(suppliers).set({ status: "withdrawn" }).where(eq(suppliers.id, otherSupplier.id));
  });

  it("reads one person's slots the same way as the whole schedule", async () => {
    const schedule = (await loadActiveSchedule(db, seeded.eventId))!;
    const refs: PersonRef[] = [
      ...seeded.buyers.map((b): PersonRef => ({ type: "buyer", id: b.id })),
      ...seeded.suppliers.map((s): PersonRef => ({ type: "supplier", id: s.id })),
    ];
    let open = 0;
    for (const ref of refs) {
      const person = (await loadPersonSchedule(db, seeded.eventId, ref))!;
      expect(person.slots).toEqual(participantSlots(schedule, ref));
      open += person.slots.filter((s) => s.appointment === null).length;
    }
    expect(open).toBeGreaterThan(0);
  });

  it("returns null for a missing event or person, and for malformed ids", async () => {
    expect(await loadActiveSchedule(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await loadActiveSchedule(db, "not-a-uuid")).toBeNull();
    expect(await loadPersonSchedule(db, seeded.eventId, { type: "supplier", id: seeded.buyers[0].id })).toBeNull();
    expect(await loadPersonSchedule(db, seeded.eventId, { type: "buyer", id: "not-a-uuid" })).toBeNull();
  });

  it("reads the whole schedule in four queries and one person in two, none of them rankings", async () => {
    const whole = recordQueries(db);
    await loadActiveSchedule(whole.db, seeded.eventId);
    expect(whole.queries).toHaveLength(4);

    const one = recordQueries(db);
    await loadPersonSchedule(one.db, seeded.eventId, { type: "supplier", id: seeded.suppliers[0].id });
    expect(one.queries).toHaveLength(2);
    expect([...whole.queries, ...one.queries].some((q) => q.includes('"rankings"'))).toBe(false);
  });

  it("builds the workspace view without reading rankings", async () => {
    const recorded = recordQueries(db);
    await getScheduleView(seeded.eventId, recorded.db);
    expect(recorded.queries).toHaveLength(6);
    expect(recorded.queries.some((q) => q.includes('"rankings"'))).toBe(false);
  });

  it("serves /s/[token] in three queries and records the view in the deferred task", async () => {
    const [buyer] = await db
      .select()
      .from(participants)
      .where(and(eq(participants.eventId, seeded.eventId), eq(participants.status, "active")))
      .limit(1);
    const issued = await issueTokenForContact(db, {
      eventId: seeded.eventId,
      contactType: "buyer",
      entityId: buyer.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const recorded = recordQueries(db);
    const deferred: (() => Promise<unknown>)[] = [];
    const view = await loadParticipantView(issued.token, recorded.db, { defer: (task) => void deferred.push(task) });
    expect(view?.schedule.person.id).toBe(buyer.id);
    expect(recorded.queries).toHaveLength(3);
    expect(recorded.queries.some((q) => q.startsWith("update"))).toBe(false);

    const viewed = async () =>
      (await db.select().from(accessTokens).where(eq(accessTokens.id, issued.tokenId)))[0].lastViewedAt;
    expect(await viewed()).toBeNull();
    expect(deferred).toHaveLength(1);
    await deferred[0]();
    expect(await viewed()).not.toBeNull();
  });
});
