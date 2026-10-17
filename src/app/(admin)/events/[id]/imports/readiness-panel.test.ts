import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { participants } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { useMemoryStorageForTests } from "@/lib/storage";
import { writeSheet } from "@/lib/xlsx";
import { createImport } from "@/server/imports/imports";
import { getImportStatusByKind } from "@/server/imports/queries";
import { getMatchingGate } from "@/server/matching/readiness";
import { seedEvent } from "@/server/matching/test-seed";
import { readinessPanelModel } from "./readiness-panel";

let db: Db;

beforeAll(async () => {
  useMemoryStorageForTests();
  db = await createTestDb();
});

async function panelFor(eventId: string) {
  const [gate, byKind] = await Promise.all([getMatchingGate(eventId, db), getImportStatusByKind(eventId, db)]);
  return readinessPanelModel(gate, byKind);
}

describe("readinessPanelModel", () => {
  it("shows ready for a seeded event with no uploads, like the matching gate", async () => {
    const seeded = await seedEvent(db);
    const panel = await panelFor(seeded.eventId);
    expect(panel).toMatchObject({ ready: true, title: "Ready to match", reasons: [], review: null });
    expect(panel.kinds.every((entry) => entry.status === "not_uploaded")).toBe(true);
  });

  it("lists the gate's reasons and links the file waiting for a fix", async () => {
    const seeded = await seedEvent(db, { buyers: 4 });
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.eventId, seeded.eventId));
    const upload = await createImport(db, {
      eventId: seeded.eventId,
      kind: "buyer_hotel_rankings",
      filename: "hotels.xlsx",
      buffer: writeSheet(["FULL_NAME", "CHOICE #1"], [["Nobody Here", "No Such Hotel"]]),
      adminId: seeded.adminId,
    });
    if (!upload.ok) throw new Error(upload.error.message);

    const panel = await panelFor(seeded.eventId);
    expect(panel.ready).toBe(false);
    expect(panel.title).toBe("Not ready to match");
    expect(panel.review).toEqual({ kind: "buyer_hotel_rankings", importId: upload.data.importId });
    expect(panel.reasons[0]).toBe("Add at least one active buyer.");
    expect(panel.reasons).toContain("The buyer hotel rankings file has unknown names. Map them, then apply the file.");
    expect(panel.kinds.find((entry) => entry.kind === "buyer_hotel_rankings")).toEqual({
      kind: "buyer_hotel_rankings",
      status: "pending",
      importId: upload.data.importId,
      state: upload.data.state,
    });
  });
});
