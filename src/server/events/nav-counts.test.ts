import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { attentionCount, buildModel } from "@/app/(admin)/events/[id]/schedule/schedule-model";
import type { Db } from "@/db/client";
import { appointments, imports, matchRuns, participants, suppliers, type NewAppointment, type NewImport } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { ImportValidationReport } from "@/lib/schemas/import";
import { startRun } from "@/server/matching/runs";
import { seedEvent, TEST_SETTINGS } from "@/server/matching/test-seed";
import { getScheduleView } from "@/server/schedule/queries";
import { getEventNavCounts } from "./nav-counts";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

function report(patch: Partial<ImportValidationReport> = {}): ImportValidationReport {
  return {
    format: "template",
    counts: { rows: 1, rankers: 0, rankings: 0, resolvedNames: 0, unknownNames: 0, errors: 0, warnings: 0 },
    errors: [],
    warnings: [],
    unresolvedNames: [],
    unknownNames: [],
    duplicateEmails: [],
    duplicateNames: [],
    missingEmails: [],
    rowsWithZeroRankings: [],
    rankedByNobody: [],
    rankedNobody: [],
    rankersInFile: [],
    ...patch,
  };
}

/** The number on the schedule's Quality badge, computed the way the workspace does. */
async function qualityBadge(eventId: string): Promise<number> {
  const view = (await getScheduleView(eventId, db))!;
  const model = buildModel(view);
  return attentionCount(model, view.event.settings) + view.health.withdrawn.length;
}

describe("getEventNavCounts", () => {
  it("returns null for an unknown event or an id that isn't a uuid", async () => {
    expect(await getEventNavCounts("00000000-0000-4000-8000-000000000000", db)).toBeNull();
    // A stale or hand-edited last-event cookie.
    expect(await getEventNavCounts("not-an-event", db)).toBeNull();
  });

  it("counts active people only and has no schedule count before matching", async () => {
    const seeded = await seedEvent(db, { buyers: 5 });
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, seeded.buyers[0].id));
    await db.update(suppliers).set({ status: "withdrawn" }).where(eq(suppliers.id, seeded.suppliers[0].id));

    expect(await getEventNavCounts(seeded.eventId, db)).toEqual({
      participants: 4,
      suppliers: 5,
      importsWaiting: 0,
      scheduleProblems: null,
    });
  });

  it("counts a kind as waiting when its latest file that isn't ignored is checked but not applied", async () => {
    const { eventId } = await seedEvent(db, { buyers: 2 });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));
    const file = (kind: NewImport["kind"], minute: number, status: NewImport["status"], validation?: ImportValidationReport) => ({
      eventId,
      kind,
      fileKey: `k-${kind}-${minute}`,
      fileName: `${kind}.csv`,
      status,
      validation: validation ?? null,
      createdAt: at(minute),
    });
    await db.insert(imports).values([
      // Waiting: checked and ready, newer than an applied file.
      file("participants", 1, "applied", report()),
      file("participants", 2, "validated", report()),
      // Not waiting: the newer file is ignored, so the applied one counts again.
      file("suppliers", 1, "applied", report()),
      file("suppliers", 2, "ignored", report()),
      // Waiting: names to map.
      file("buyer_biztech_rankings", 1, "validated", report({ unknownNames: [{ raw: "Acme", entityType: "supplier", role: "target", rows: [2], suggestions: [] }] })),
      // Waiting: errors to fix.
      file("buyer_hotel_rankings", 1, "validated", report({ errors: [{ row: 3, message: "Bad rank" }] })),
      // Not waiting: the file couldn't be read.
      file("supplier_rankings", 1, "failed"),
    ]);

    expect((await getEventNavCounts(eventId, db))?.importsWaiting).toBe(3);
  });

  it("counts schedule problems like the Quality badge: off-target people plus meetings with someone who withdrew", async () => {
    const seeded = await seedEvent(db, { buyers: 12 });
    const [run] = await db
      .insert(matchRuns)
      .values({ eventId: seeded.eventId, status: "completed", settingsSnapshot: TEST_SETTINGS, isActive: true })
      .returning();
    // Suppliers 0 to 2 meet buyers 0 to 8 once each: 9 meetings per supplier
    // (on target) and 3 per buyer (within 3 to 6). Suppliers 3 to 5 and
    // buyers 9 to 11 have none.
    const rows: NewAppointment[] = [];
    for (let s = 0; s < 3; s++) {
      for (let b = 0; b < 9; b++) {
        rows.push({
          runId: run.id,
          eventId: seeded.eventId,
          slot: ((b + s) % 9) + 1,
          buyerId: seeded.buyers[b].id,
          supplierId: seeded.suppliers[s].id,
          source: "engine",
        });
      }
    }
    await db.insert(appointments).values(rows);
    // 3 suppliers off target + 3 buyers under the minimum.
    expect((await getEventNavCounts(seeded.eventId, db))?.scheduleProblems).toBe(6);

    // Withdrawn people are never flagged, but their 3 booked meetings are.
    await db
      .update(participants)
      .set({ status: "withdrawn" })
      .where(inArray(participants.id, [seeded.buyers[0].id, seeded.buyers[11].id]));
    await db.update(suppliers).set({ status: "withdrawn" }).where(eq(suppliers.id, seeded.suppliers[5].id));
    const counts = await getEventNavCounts(seeded.eventId, db);
    expect(counts?.scheduleProblems).toBe(2 + 2 + 3);
    expect(counts?.scheduleProblems).toBe(await qualityBadge(seeded.eventId));
  });

  it("matches the Quality badge on an engine run", async () => {
    const seeded = await seedEvent(db, { buyers: 10, settings: { buyerMin: 4 } });
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    if (!run.ok) throw new Error(run.error.message);
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, seeded.buyers[1].id));

    const badge = await qualityBadge(seeded.eventId);
    expect(badge).toBeGreaterThan(0);
    expect((await getEventNavCounts(seeded.eventId, db))?.scheduleProblems).toBe(badge);
  });
});
