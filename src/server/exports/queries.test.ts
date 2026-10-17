import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { auditEvents, matchRuns } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { exportAvailability } from "./queries";

let db: Db;
let seeded: Seeded;
let runId: string;
let runVersion: number;

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
  const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
  if (!run.ok) throw new Error(run.error.message);
  runId = run.data.runId;
  [{ version: runVersion }] = await db.select({ version: matchRuns.version }).from(matchRuns).where(eq(matchRuns.id, runId));
});

async function recordAt(
  kind: string,
  createdAt: string,
  extra: { id?: string; adminId?: string | null; runVersion?: number } = {},
) {
  await db.insert(auditEvents).values({
    ...(extra.id ? { id: extra.id } : {}),
    eventId: seeded.eventId,
    adminId: extra.adminId === undefined ? seeded.adminId : extra.adminId,
    action: `export.${kind}`,
    entityType: "event",
    after: { runId, runVersion: extra.runVersion ?? runVersion },
    createdAt: new Date(createdAt),
  });
}

describe("exportAvailability latest export per kind", () => {
  it("leaves last empty for kinds that were never exported", async () => {
    const availability = (await exportAvailability(seeded.eventId, db))!;
    for (const state of Object.values(availability.exports)) {
      expect(state.last).toBeNull();
      expect(state.scheduleChanged).toBe(false);
    }
  });

  it("uses the newest row of each kind, however long the history is", async () => {
    for (let i = 0; i < 5; i++) await recordAt("master", `2026-10-0${i + 1}T10:00:00Z`);
    await recordAt("report", "2026-10-02T10:00:00Z");
    const availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.master.last?.at).toEqual(new Date("2026-10-05T10:00:00Z"));
    expect(availability.exports.report.last?.at).toEqual(new Date("2026-10-02T10:00:00Z"));
    expect(availability.exports.schedules.last).toBeNull();
  });

  it("shows a null admin name when the row has no admin", async () => {
    await recordAt("suppliers_full", "2026-10-06T10:00:00Z", { adminId: null });
    const availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.suppliers_full.last).toMatchObject({ byName: null });
    expect(availability.exports.report.last?.byName).toBe("Test Admin");
  });

  it("breaks an equal timestamp by the higher id", async () => {
    const at = "2026-10-07T10:00:00Z";
    await recordAt("schedules", at, { id: "00000000-0000-4000-8000-0000000000bb", runVersion: runVersion + 7 });
    await recordAt("schedules", at, { id: "00000000-0000-4000-8000-0000000000aa", runVersion: runVersion + 3 });
    const availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.schedules.last?.runVersion).toBe(runVersion + 7);
  });

  it("flags a change when the newest export saw an older run version, not an older row", async () => {
    await recordAt("report", "2026-10-08T10:00:00Z", { runVersion: runVersion - 1 });
    let availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.report.scheduleChanged).toBe(true);
    await recordAt("report", "2026-10-09T10:00:00Z");
    availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.report.scheduleChanged).toBe(false);
  });
});
