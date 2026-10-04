import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { participants, rankings } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { compareWithActiveRun, getMatchingReadiness } from "./queries";
import { startRun } from "./runs";
import { seedEvent, type Seeded } from "./test-seed";

let db: Db;
let seeded: Seeded;

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
});

describe("getMatchingReadiness", () => {
  it("counts active people and rankings by who ranked", async () => {
    const all = await db.select().from(rankings).where(eq(rankings.eventId, seeded.eventId));
    const readiness = await getMatchingReadiness(seeded.eventId, db);
    expect(readiness).toEqual({
      buyers: 12,
      suppliers: 6,
      buyerRankings: all.filter((r) => r.rankerType === "buyer").length,
      supplierRankings: all.filter((r) => r.rankerType === "supplier").length,
    });
  });

  it("leaves withdrawn buyers out", async () => {
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, seeded.buyers[0].id));
    expect((await getMatchingReadiness(seeded.eventId, db)).buyers).toBe(11);
    await db.update(participants).set({ status: "active" }).where(eq(participants.id, seeded.buyers[0].id));
  });

  it("is all zeros for an unknown event", async () => {
    expect(await getMatchingReadiness("00000000-0000-4000-8000-000000000000", db)).toEqual({
      buyers: 0,
      suppliers: 0,
      buyerRankings: 0,
      supplierRankings: 0,
    });
  });
});

describe("compareWithActiveRun", () => {
  it("is null for the active run and compares any other run against it", async () => {
    const first = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    const second = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: true });
    if (!first.ok || !second.ok) throw new Error("runs failed");
    expect(await compareWithActiveRun(seeded.eventId, first.data.runId, db)).toBeNull();
    const comparison = await compareWithActiveRun(seeded.eventId, second.data.runId, db);
    expect(comparison?.ok).toBe(true);
    if (comparison?.ok) {
      // Keeping existing pins every appointment, so nothing is removed.
      expect(comparison.data.removed).toEqual([]);
    }
  });
});
