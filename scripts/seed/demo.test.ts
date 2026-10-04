import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { auditEvents, events, participants, rankings, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { BOM } from "@/server/exports/common";
import { masterScheduleCsv } from "@/server/exports/master";
import { scheduleZipEntries } from "@/server/exports/schedules";
import { planDesks } from "@/server/schedule/lock";
import { getScheduleView } from "@/server/schedule/views";
import { DEMO_EVENT_NAME, seedDemo, seedTargetRefusal, type SeedSummary } from "./demo";
import { loadFixture } from "./fixture";

let db: Db;
let first: SeedSummary;

beforeAll(async () => {
  db = await createTestDb();
  first = await seedDemo(db, loadFixture());
}, 60_000);

describe("seedDemo", () => {
  it("builds the 2025 event as matched, with an active run of 504 appointments", async () => {
    expect(first).toMatchObject({ adminCreated: true, replacedEvents: 0, participants: 65, suppliers: 56, appointments: 504 });
    const [event] = await db.select().from(events).where(eq(events.id, first.eventId));
    expect(event).toMatchObject({ name: DEMO_EVENT_NAME, eventDate: "2025-11-14", timezone: "America/Los_Angeles", status: "matched" });

    const view = (await getScheduleView(first.eventId, db))!;
    expect(view.appointments).toHaveLength(504);
    expect(view.run?.stats).toMatchObject({
      totalAppointments: 504,
      mutualTopN: { count: 126, pct: 25 },
      buyerDistribution: { 5: 1, 6: 2, 7: 13, 8: 45, 9: 4 },
    });
    expect(view.suppliers.every((s) => s.count === 9 && s.desk !== null)).toBe(true);
    expect(view.slots[0]).toMatchObject({ start: "3:10 PM", end: "3:20 PM" });
  });

  it("feeds the exports: 504 master rows and 121 schedule files", async () => {
    const view = (await getScheduleView(first.eventId, db))!;
    expect(masterScheduleCsv(view).slice(BOM.length).trimEnd().split("\n")).toHaveLength(505);
    const entries = scheduleZipEntries(view);
    expect(entries).toHaveLength(121);
    expect(new Set(entries.map((e) => e.path)).size).toBe(121);
  });

  it("splits organisation and title and opts every buyer in to biztech", async () => {
    const rows = await db.select().from(participants).where(eq(participants.eventId, first.eventId));
    expect(rows.every((p) => p.organization && p.biztechOptIn && p.email.endsWith("@example.org"))).toBe(true);
    const ranked = await db.select().from(rankings).where(eq(rankings.eventId, first.eventId));
    expect(ranked).toHaveLength(65 * 56 - 17 + 56 * 65);
  });

  it("numbers desks the way lock does, so locking the demo keeps them (D17)", async () => {
    const rows = await db.select().from(suppliers).where(eq(suppliers.eventId, first.eventId));
    const planned = new Map(planDesks(rows).map((p) => [p.supplierId, p.desk]));
    expect(rows.every((s) => s.deskNumber === planned.get(s.id) && !s.deskOverride)).toBe(true);
    const byName = Object.fromEntries(rows.map((s) => [s.name, s.deskNumber]));
    expect(byName["Art of Mentoring"]).toBe(1);
    expect(byName["eShow"]).toBe(7);
    expect(byName["San Diego Tourism Authority"]).toBeLessThan(byName["SEAS Productions"]!);
  });

  it("replaces the event on a second run and keeps the admin", async () => {
    const second = await seedDemo(db, loadFixture());
    expect(second).toMatchObject({ adminCreated: false, adminId: first.adminId, replacedEvents: 1 });
    const demo = await db.select().from(events).where(eq(events.name, DEMO_EVENT_NAME));
    expect(demo.map((e) => e.id)).toEqual([second.eventId]);
    const orphaned = await db.select().from(auditEvents).where(eq(auditEvents.eventId, first.eventId));
    expect(orphaned).toHaveLength(0);
  }, 60_000);
});

describe("seedTargetRefusal", () => {
  it("allows PGlite and a local Postgres", () => {
    expect(seedTargetRefusal({})).toBeNull();
    expect(seedTargetRefusal({ DATABASE_URL: "postgres://aw:aw@localhost:5432/aw" })).toBeNull();
    expect(seedTargetRefusal({ DATABASE_URL: "postgres://aw:aw@127.0.0.1:5432/aw" })).toBeNull();
  });

  it("refuses production and remote databases unless SEED_ALLOW_REMOTE=1", () => {
    expect(seedTargetRefusal({ NODE_ENV: "production" })).toMatch(/NODE_ENV is production/);
    const remote = seedTargetRefusal({ DATABASE_URL: "postgres://u:secret@ep-x.neon.tech/aw" });
    expect(remote).toMatch(/points at ep-x\.neon\.tech/);
    expect(remote).not.toContain("secret");
    expect(seedTargetRefusal({ DATABASE_URL: "postgres://u:p@ep-x.neon.tech/aw", SEED_ALLOW_REMOTE: "1" })).toBeNull();
    expect(seedTargetRefusal({ NODE_ENV: "production", SEED_ALLOW_REMOTE: "1" })).toBeNull();
  });
});
