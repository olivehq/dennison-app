import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { imports, participants, rankings, type ImportValidation } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { ImportValidationReport } from "@/lib/schemas/import";
import { matchingReadiness } from "./readiness";
import { startRun } from "./runs";
import { seedEvent } from "./test-seed";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

function report(errors: { row: number | null; message: string }[] = []): ImportValidationReport {
  return {
    format: null,
    counts: { rows: 1, rankers: 0, rankings: 0, resolvedNames: 0, unknownNames: 0, errors: errors.length, warnings: 0 },
    errors,
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
  };
}

describe("matchingReadiness (scope 2.3)", () => {
  it("is ready for the seed's rankings loaded without imports", async () => {
    const seeded = await seedEvent(db);
    expect(await matchingReadiness(db, seeded.eventId)).toMatchObject({ ready: true, reasons: [] });
  });

  it("needs active people and both sides' rankings", async () => {
    const seeded = await seedEvent(db, { buyers: 4 });
    await db.delete(rankings).where(eq(rankings.eventId, seeded.eventId));
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.eventId, seeded.eventId));
    const readiness = await matchingReadiness(db, seeded.eventId);
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      "Add at least one active buyer.",
      "Load the buyer rankings.",
      "Load the supplier rankings.",
    ]);
  });

  it("gives one reason per cause: a waiting file of a kind replaces 'Load the ...' for that kind", async () => {
    const seeded = await seedEvent(db, { buyers: 4 });
    await db.delete(rankings).where(eq(rankings.eventId, seeded.eventId));
    const base = { eventId: seeded.eventId, fileKey: "k", fileName: "f.csv", createdBy: seeded.adminId };
    await db.insert(imports).values({
      ...base,
      kind: "supplier_rankings",
      status: "validated",
      validation: report() as unknown as ImportValidation,
    });
    const readiness = await matchingReadiness(db, seeded.eventId);
    expect(readiness.reasons).toEqual([
      "Load the buyer rankings.",
      "The supplier rankings file is checked but not applied. Apply it.",
    ]);

    // Either buyer ranking file covers the buyer side.
    await db.insert(imports).values({
      ...base,
      kind: "buyer_hotel_rankings",
      status: "validated",
      validation: report() as unknown as ImportValidation,
    });
    expect((await matchingReadiness(db, seeded.eventId)).reasons).toEqual([
      "The buyer hotel rankings file is checked but not applied. Apply it.",
      "The supplier rankings file is checked but not applied. Apply it.",
    ]);
  });

  it("blocks on an import left checked but not applied, or with errors, and startRun refuses with the reasons", async () => {
    const seeded = await seedEvent(db, { buyers: 4 });
    const base = { eventId: seeded.eventId, fileKey: "k", fileName: "f.csv", createdBy: seeded.adminId };
    await db.insert(imports).values([
      { ...base, kind: "supplier_rankings", status: "validated", validation: report() as unknown as ImportValidation },
      {
        ...base,
        kind: "buyer_hotel_rankings",
        status: "validated",
        validation: report([{ row: 2, message: "Bad rank" }]) as unknown as ImportValidation,
      },
    ]);
    const readiness = await matchingReadiness(db, seeded.eventId);
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      "The buyer hotel rankings file has errors. Fix it and upload it again.",
      "The supplier rankings file is checked but not applied. Apply it.",
    ]);

    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    expect(run).toEqual({ ok: false, error: { code: "validation", message: readiness.reasons.join(" ") } });

    // Applying (here: marking applied) clears it.
    await db.update(imports).set({ status: "applied" }).where(eq(imports.eventId, seeded.eventId));
    expect((await matchingReadiness(db, seeded.eventId)).ready).toBe(true);
  });

  it("blocks on a latest import that failed validation, even with older rankings applied", async () => {
    const seeded = await seedEvent(db, { buyers: 4 });
    const base = { eventId: seeded.eventId, fileKey: "k", fileName: "f.csv", createdBy: seeded.adminId, kind: "supplier_rankings" as const };
    await db.insert(imports).values({ ...base, status: "applied", createdAt: new Date(Date.now() - 60_000) });
    await db.insert(imports).values({ ...base, status: "failed", validation: report([{ row: null, message: "Not a spreadsheet" }]) as unknown as ImportValidation });
    const readiness = await matchingReadiness(db, seeded.eventId);
    expect(readiness).toMatchObject({
      ready: false,
      reasons: ["The latest supplier rankings upload failed validation. Fix or delete it."],
    });
  });

  it("skips ignored imports, so the file before an ignored one counts again", async () => {
    const seeded = await seedEvent(db, { buyers: 4 });
    const base = { eventId: seeded.eventId, fileKey: "k", fileName: "f.csv", createdBy: seeded.adminId };
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
    await db.insert(imports).values([
      // An applied biztech file, then a newer one checked but never applied, then ignored.
      { ...base, kind: "buyer_biztech_rankings", status: "applied", createdAt: minutesAgo(3) },
      { ...base, kind: "buyer_biztech_rankings", status: "ignored", validation: report() as unknown as ImportValidation, createdAt: minutesAgo(2) },
      // The only supplier file is ignored, and it had failed: nothing of that kind blocks.
      { ...base, kind: "supplier_rankings", status: "ignored", validation: report([{ row: null, message: "Bad" }]) as unknown as ImportValidation },
    ]);
    expect(await matchingReadiness(db, seeded.eventId)).toMatchObject({ ready: true, reasons: [] });

    // The same file not ignored blocks, as before.
    await db
      .update(imports)
      .set({ status: "validated" })
      .where(and(eq(imports.eventId, seeded.eventId), eq(imports.kind, "buyer_biztech_rankings"), eq(imports.status, "ignored")));
    expect((await matchingReadiness(db, seeded.eventId)).reasons).toEqual([
      "The buyer biztech rankings file is checked but not applied. Apply it.",
    ]);
  });
});

