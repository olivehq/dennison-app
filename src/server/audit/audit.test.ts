import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { admins, events } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas";
import { listAudit, recordAudit } from "./audit";

let db: Db;
let eventId: string;
const adminId = "admin-1";

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(admins).values({ id: adminId, name: "Ann", email: "ann@example.com" });
  const [event] = await db
    .insert(events)
    .values({ name: "AW 2026", eventDate: "2026-11-10", timezone: "America/Los_Angeles", settings: defaultEventSettings })
    .returning();
  eventId = event.id;
});

describe("audit", () => {
  it("records rows inside a transaction and lists them newest first", async () => {
    await db.transaction(async (tx) => {
      await recordAudit(tx, {
        eventId,
        adminId,
        action: "participant.withdraw",
        entityType: "participant",
        entityId: "p-1",
        before: { status: "active" },
        after: { status: "withdrawn" },
      });
      await recordAudit(tx, {
        eventId,
        adminId,
        action: "appointment.replace",
        entityType: "appointment",
        entityId: "a-1",
        note: "Swapped per buyer request",
      });
    });

    const page = await listAudit({ eventId }, db);
    expect(page.total).toBe(2);
    expect(page.rows[0].action).toBe("appointment.replace");
    expect(page.rows[1].before).toEqual({ status: "active" });
  });

  it("filters by action, entity, and admin, and paginates", async () => {
    const byAction = await listAudit({ eventId, filters: { action: "participant.withdraw" } }, db);
    expect(byAction.rows.map((r) => r.entityId)).toEqual(["p-1"]);

    const byEntity = await listAudit({ eventId, filters: { entityType: "appointment", entityId: "a-1" } }, db);
    expect(byEntity.total).toBe(1);

    const byOther = await listAudit({ eventId, filters: { adminId: "nobody" } }, db);
    expect(byOther.total).toBe(0);

    const firstPage = await listAudit({ eventId, page: 1, pageSize: 1 }, db);
    const secondPage = await listAudit({ eventId, page: 2, pageSize: 1 }, db);
    expect(firstPage.rows).toHaveLength(1);
    expect(secondPage.rows).toHaveLength(1);
    expect(firstPage.rows[0].id).not.toBe(secondPage.rows[0].id);
  });

  it("lists team changes separately under a null event", async () => {
    await recordAudit(db, {
      eventId: null,
      adminId,
      action: "admin.invite",
      entityType: "admin_invite",
      entityId: "i-1",
    });
    const team = await listAudit({ eventId: null }, db);
    expect(team.total).toBe(1);
    expect(team.rows[0].action).toBe("admin.invite");
    expect((await listAudit({ eventId }, db)).total).toBe(2);
  });

  it("filters by action group, person, and time window", async () => {
    const [other] = await db
      .insert(events)
      .values({ name: "AW 2027", eventDate: "2027-11-10", timezone: "America/Los_Angeles", settings: defaultEventSettings })
      .returning();
    const buyer = "11111111-1111-4111-8111-111111111111";
    const supplier = "22222222-2222-4222-8222-222222222222";
    const write = (action: string, extra: Partial<Parameters<typeof recordAudit>[1]> = {}) =>
      recordAudit(db, { eventId: other.id, adminId, action, entityType: action.split(".")[0], ...extra });
    await write("appointment.add", { after: { buyerId: buyer, supplierId: supplier, slot: 1 } });
    await write("appointment.remove", { before: { buyerId: "33333333-3333-4333-8333-333333333333", supplierId: supplier } });
    await write("participant.withdraw", { entityId: buyer });
    await write("token.revoke", { after: { contactType: "buyer", entityId: buyer } });
    await write("schedule.lock");
    await write("schedule_like.lock");

    const ids = async (filters: Parameters<typeof listAudit>[0]["filters"]) =>
      (await listAudit({ eventId: other.id, filters }, db)).rows.map((r) => r.action).sort();

    expect(await ids({ actions: ["appointment.", "schedule.reassign_desks"] })).toEqual([
      "appointment.add",
      "appointment.remove",
    ]);
    expect(await ids({ actions: ["schedule.lock", "schedule.unlock"] })).toEqual(["schedule.lock"]);
    // "schedule_" must not act as a LIKE wildcard.
    expect(await ids({ actions: ["schedule_."] })).toEqual([]);
    expect(await ids({ actions: [] })).toEqual([]);
    expect(await ids({ personId: buyer })).toEqual(["appointment.add", "participant.withdraw", "token.revoke"]);
    expect(await ids({ personId: supplier })).toEqual(["appointment.add", "appointment.remove"]);

    const future = new Date(Date.now() + 60_000);
    expect(await ids({ from: future })).toEqual([]);
    expect((await ids({ to: future })).length).toBe(6);
    expect(await ids({ to: new Date(0) })).toEqual([]);
  });
});
