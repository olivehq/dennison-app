import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { imports } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { recordQueries } from "@/server/events/test-race";
import { seedEvent } from "@/server/matching/test-seed";
import { getImportStatusByKind } from "./queries";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

const EARLIER = new Date("2026-10-01T10:00:00Z");
const LATER = new Date("2026-10-02T10:00:00Z");

type Row = typeof imports.$inferInsert;

function row(eventId: string, kind: Row["kind"], status: Row["status"], createdAt: Date, extra: Partial<Row> = {}): Row {
  return { eventId, kind, status, createdAt, fileKey: `k-${Math.random()}`, fileName: `${kind}-${status}.xlsx`, ...extra };
}

describe("getImportStatusByKind", () => {
  it("reads the latest file per kind in one query, skipping ignored files", async () => {
    const { eventId, adminId } = await seedEvent(db);
    const other = await seedEvent(db);
    const tieLow = "00000000-0000-4000-8000-000000000001";
    const tieHigh = "00000000-0000-4000-8000-000000000002";
    await db.insert(imports).values([
      // An ignored newest file: the one before it counts again.
      row(eventId, "participants", "applied", EARLIER, { createdBy: adminId }),
      row(eventId, "participants", "ignored", LATER),
      // A failed newest file still counts.
      row(eventId, "suppliers", "applied", EARLIER),
      row(eventId, "suppliers", "failed", LATER),
      // Same timestamp: the higher id wins.
      row(eventId, "buyer_biztech_rankings", "applied", LATER, { id: tieLow }),
      row(eventId, "buyer_biztech_rankings", "applied", LATER, { id: tieHigh }),
      // Only ignored files read as none.
      row(eventId, "buyer_hotel_rankings", "ignored", LATER),
      // Another event's file never leaks in.
      row(other.eventId, "supplier_rankings", "applied", LATER),
    ]);

    const recorded = recordQueries(db);
    const latest = await getImportStatusByKind(eventId, recorded.db);

    expect(recorded.queries).toHaveLength(1);
    expect(Object.keys(latest)).toEqual([
      "participants",
      "suppliers",
      "buyer_biztech_rankings",
      "buyer_hotel_rankings",
      "supplier_rankings",
    ]);
    expect(latest.participants).toMatchObject({ state: "applied", createdAt: EARLIER, createdByName: "Test Admin" });
    expect(latest.suppliers).toMatchObject({ state: "failed", createdAt: LATER });
    expect(latest.buyer_biztech_rankings?.id).toBe(tieHigh);
    expect(latest.buyer_hotel_rankings).toBeNull();
    expect(latest.supplier_rankings).toBeNull();
  });

  it("reads fresh inside a transaction", async () => {
    const { eventId } = await seedEvent(db);
    await db.insert(imports).values(row(eventId, "participants", "applied", EARLIER));
    expect((await getImportStatusByKind(eventId)).participants?.state).toBe("applied");

    const seen = await db.transaction(async (tx) => {
      await tx.insert(imports).values(row(eventId, "participants", "failed", LATER));
      return getImportStatusByKind(eventId, tx);
    });
    expect(seen.participants?.state).toBe("failed");
  });
});
