import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens, admins, auditEvents, events, imports, nameAliases, participants, rankings, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas";
import type { ImportKind } from "@/lib/schemas/import";
import { deleteFile, getFile, importFileKey, useMemoryStorageForTests } from "@/lib/storage";
import { writeSheet } from "@/lib/xlsx";
import { EVENT_CHANGED_MESSAGE } from "@/server/events/editable";
import { raceBeforeTransaction } from "@/server/events/test-race";
import { issueTokenForContact, verifyToken } from "@/server/tokens/tokens";
import { applyImport, createImport, deleteImportRecord, ignoreImport, revalidateImport, saveAlias, saveAliases, stopIgnoringImport } from "./imports";
import { matchingReadiness } from "@/server/matching/readiness";
import { getImport, getImportStatusByKind, listImports } from "./queries";

// Real ids by default; a test can fix the next one to know an upload's storage key.
// Real storage by default; a test can make the next delete fail.
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, deleteFile: vi.fn(actual.deleteFile) };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

let db: Db;
let eventId: string;
const adminId = "admin-1";

const fixture = readFileSync("fixtures/eshow-2026-sample-ratings.xlsx");

const participantHeaders = ["Email", "First name", "Last name", "Organization", "Title", "Biztech opt-in"];
const supplierHeaders = ["Name", "Type", "Admin contact name", "Admin contact email", "Attendee contact name", "Attendee contact email"];

/** The 25 supplier names in the eShow sample, as they appear in the file. */
const fixtureSuppliers = [
  "SEAS Productions",
  "Sonesta Redondo Beach & Marina",
  "Peregrine Hospitality",
  "San Diego Tourism Authority",
  "Explore Seattle Southside",
  "Los Angeles Tourism & Convention Board",
  "Monterey Plaza Hotel & Spa",
  "See Monterey",
  "GOCAL (Greater Ontario California)",
  "Hilton Irvine/Orange County Airport",
  "Holiday Inn Sacramento Downtown - Arena",
  "Expo Convention Contractors",
  "Sonoma County Tourism",
  "Lake Arrowhead Resort and Spa",
  "Discover Riverside Convention & Visitors Bureau",
  "Cache Creek Casino Resort",
  "Heritage Exposition Services",
  "Dennison & Associates",
  "The Lakehouse Resort",
  "The Ameswell Hotel",
  "Visit Visalia",
  "Visit San Jose",
  "Visit Tri-Valley",
  "Visit SLO CAL",
  "Visit Rancho Cordova",
];
const businessNames = new Set(["SEAS Productions", "Expo Convention Contractors", "Heritage Exposition Services", "Dennison & Associates"]);

function upload(kind: ImportKind, buffer: Buffer, filename = `${kind}.xlsx`, event = eventId) {
  return createImport(db, { eventId: event, kind, filename, buffer, adminId });
}

async function expectOk<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): Promise<T> {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

function listSheet(rows: { name: string; email?: string; choices: string[] }[]): Buffer {
  const max = Math.max(1, ...rows.map((row) => row.choices.length));
  const headers = ["FIRST_NAME", "LAST_NAME", "FULL_NAME", "EMAIL"];
  for (let n = 1; n <= max; n += 1) headers.push(`CHOICE #${n}`);
  return writeSheet(
    headers,
    rows.map((row) => {
      const [first, ...rest] = row.name.split(" ");
      return [first, rest.join(" "), row.name, row.email ?? "", ...row.choices];
    }),
    "Report",
  );
}

async function participantByEmail(email: string) {
  const [row] = await db.select().from(participants).where(and(eq(participants.eventId, eventId), eq(participants.email, email)));
  return row;
}

async function rankingsFor(importId: string) {
  return db.select().from(rankings).where(eq(rankings.importId, importId)).orderBy(rankings.rank);
}

beforeAll(async () => {
  useMemoryStorageForTests();
  db = await createTestDb();
  await db.insert(admins).values({ id: adminId, name: "Admin", email: "admin@example.com" });
  const [event] = await db
    .insert(events)
    .values({ name: "AW 2026", eventDate: "2026-11-10", timezone: "America/Los_Angeles", settings: defaultEventSettings })
    .returning();
  eventId = event.id;
});

describe("participants import", () => {
  it("validates, applies, and updates without duplicating; withdrawn people stay withdrawn", async () => {
    const first = await expectOk(
      await upload(
        "participants",
        writeSheet(participantHeaders, [
          ["test1@example.com", "TestFirst1", "TestLast1", "Acme", "VP", "yes"],
          ["ann@example.com", "Ann", "Lee", "HelmsBriscoe", "Director", ""],
          ["bob@example.com", "Bob", "Ray", "HelmsBriscoe", "Manager", "no"],
          ["dee@example.com", "Dee", "Fox", "", "", ""],
        ]),
      ),
    );
    expect(first.state).toBe("ready");
    expect(first.report).toMatchObject({ format: "template", counts: { rows: 4, errors: 0, unknownNames: 0 } });
    const applied = await expectOk(await applyImport(db, { importId: first.importId, adminId }));
    expect(applied.summary).toMatchObject({ kind: "participants", created: 4, updated: 0, eventAdvanced: true });
    const [advanced] = await db.select({ status: events.status }).from(events).where(eq(events.id, eventId));
    expect(advanced.status).toBe("imported");
    expect((await participantByEmail("test1@example.com")).biztechOptIn).toBe(true);
    expect((await participantByEmail("ann@example.com")).biztechOptIn).toBe(false);

    const dup = await expectOk(
      await upload(
        "participants",
        writeSheet(participantHeaders, [
          ["ann@example.com", "Ann", "Lee", "", "", ""],
          ["ANN@example.com", "Ann", "Lee", "", "", ""],
          ["", "No", "Email", "", "", ""],
        ]),
      ),
    );
    expect(dup.state).toBe("needs_fixes");
    expect(dup.report.duplicateEmails).toEqual([{ value: "ann@example.com", rows: [2, 3] }]);
    expect(dup.report.missingEmails).toEqual([4]);
    const refused = await applyImport(db, { importId: dup.importId, adminId });
    expect(refused).toMatchObject({ ok: false, error: { code: "validation" } });

    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.email, "dee@example.com"));
    const second = await expectOk(
      await upload(
        "participants",
        writeSheet(participantHeaders, [
          ["ann@example.com", "Ann", "Lee", "HelmsBriscoe", "Senior Director", ""],
          ["dee@example.com", "Dee", "Fox", "Fox Travel", "", "yes"],
          ["eve@example.com", "Eve", "Kim", "", "", ""],
        ]),
      ),
    );
    expect(second.state).toBe("ready");
    expect(second.report.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("dee@example.com is withdrawn"), expect.stringContaining("not in this file")]),
    );
    const result = await expectOk(await applyImport(db, { importId: second.importId, adminId }));
    expect(result.summary).toMatchObject({ created: 1, updated: 2 });
    expect(await db.select().from(participants).where(eq(participants.eventId, eventId))).toHaveLength(5);
    expect(await participantByEmail("ann@example.com")).toMatchObject({ title: "Senior Director", biztechOptIn: false });
    expect(await participantByEmail("dee@example.com")).toMatchObject({ status: "withdrawn", organization: "Fox Travel", biztechOptIn: true });

    const detail = await getImport(second.importId, db);
    expect(detail).toMatchObject({ state: "applied", status: "applied", createdByName: "Admin" });
    expect(detail?.appliedAt).toBeInstanceOf(Date);
  });

  it("stores a parse failure as a failed import with the message", async () => {
    const outcome = await expectOk(await upload("participants", Buffer.from("not a workbook at all", "utf8"), "junk.csv"));
    expect(outcome.state).toBe("failed");
    expect(outcome.report.errors[0].message).toContain("Missing required column");
    const garbage = await expectOk(await upload("participants", Buffer.from([0, 1, 2, 3]), "junk.xlsx"));
    expect(garbage.state).toBe("failed");
    expect(garbage.report.errors).toHaveLength(1);
    expect((await getImport(garbage.importId, db))?.status).toBe("failed");
  });

  it("refuses a sheet over the row limit with a plain message in the report", async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => [`p${i}@example.com`, "A", "B", "", "", ""]);
    const outcome = await expectOk(await upload("participants", writeSheet(participantHeaders, rows), "huge.xlsx"));
    expect(outcome.state).toBe("failed");
    expect(outcome.report.errors[0].message).toBe(
      'Sheet "Sheet1" has more than 10,000 rows. Remove empty or extra rows, or split the file.',
    );
    await deleteImportRecord(db, { importId: outcome.importId, adminId });
  });
});

describe("suppliers import", () => {
  it("creates suppliers with their type from the template (D4)", async () => {
    const rows = fixtureSuppliers
      .filter((name) => name !== "Visit SLO CAL" && name !== "Lake Arrowhead Resort and Spa")
      .map((name) => [name, businessNames.has(name) ? "business" : "hotel", "", "", "", ""]);
    rows.push(["Visit San Luis Obispo County (SLO CAL)", "hotel", "Pat", "pat@slocal.com", "", ""]);
    rows.push(["Lake Arrowhead Resort & Spa", "hotel", "", "", "", ""]);
    const outcome = await expectOk(await upload("suppliers", writeSheet(supplierHeaders, rows)));
    expect(outcome.state).toBe("ready");
    const applied = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    expect(applied.summary).toMatchObject({ created: 25, updated: 0, eventAdvanced: false });
    const all = await db.select().from(suppliers).where(eq(suppliers.eventId, eventId));
    expect(all.filter((s) => s.type === "business")).toHaveLength(4);

    const again = await expectOk(await upload("suppliers", writeSheet(supplierHeaders, [["seas productions", "business", "Lee", "lee@seas.com", "", ""]])));
    expect(again.report.warnings.some((w) => w.message.includes("not in this file"))).toBe(true);
    const reapplied = await expectOk(await applyImport(db, { importId: again.importId, adminId }));
    expect(reapplied.summary).toMatchObject({ created: 0, updated: 1 });
    expect(await db.select().from(suppliers).where(eq(suppliers.eventId, eventId))).toHaveLength(25);
  });

  it("a changed contact email revokes the old link and issues one for the new address (D128)", async () => {
    const name = "Email Change Test Inn";
    const first = await expectOk(await upload("suppliers", writeSheet(supplierHeaders, [[name, "hotel", "Pat", "pat@inn.test", "", ""]])));
    await expectOk(await applyImport(db, { importId: first.importId, adminId }));
    const [slo] = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.eventId, eventId), eq(suppliers.name, name)));
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const old = await issueTokenForContact(db, { eventId, contactType: "supplier_admin", entityId: slo.id, expiresAt });

    const file = writeSheet(supplierHeaders, [[name, "hotel", "Pat", "pat.new@inn.test", "", ""]]);
    const outcome = await expectOk(await upload("suppliers", file));
    await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));

    expect(await verifyToken(db, old.token)).toBeNull();
    const live = await db
      .select()
      .from(accessTokens)
      .where(and(eq(accessTokens.entityId, slo.id), eq(accessTokens.contactType, "supplier_admin"), isNull(accessTokens.revokedAt)));
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(old.tokenId);
  });
});

describe("buyer hotel rankings from the eShow sample", () => {
  let importId: string;

  it("needs mapping for the one name that does not resolve, skips the empty test row", async () => {
    const outcome = await expectOk(await upload("buyer_hotel_rankings", fixture, "2026_SS2026_ATTENDEE_RATINGS.xlsx"));
    importId = outcome.importId;
    expect(outcome.state).toBe("needs_mapping");
    expect(outcome.report.format).toBe("list");
    expect(outcome.report.unknownNames).toHaveLength(1);
    expect(outcome.report.unknownNames[0]).toMatchObject({ raw: "Visit SLO CAL", entityType: "supplier", role: "target", rows: [3] });
    expect(outcome.report.unknownNames[0].suggestions[0].name).toBe("Visit San Luis Obispo County (SLO CAL)");
    expect(outcome.report.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('"Jamie Test" is not on the roster and ranked nobody')]),
    );
    expect(outcome.report.warnings.some((w) => w.message.includes("SEAS Productions is a business supplier"))).toBe(true);
    expect(outcome.report.rankedNobody.map((r) => r.name)).toEqual(
      expect.arrayContaining(["Ann Lee (HelmsBriscoe)", "Bob Ray (HelmsBriscoe)", "Eve Kim"]),
    );
    expect(outcome.report.rankedNobody.map((r) => r.name)).not.toContain("Dee Fox (Fox Travel)");

    const refused = await applyImport(db, { importId, adminId });
    expect(refused).toMatchObject({ ok: false, error: { code: "validation", message: expect.stringContaining("Map every unknown name") } });
  });

  it("becomes ready after the alias is saved and applies ranks 1..25", async () => {
    const [slo] = await db.select().from(suppliers).where(eq(suppliers.name, "Visit San Luis Obispo County (SLO CAL)"));
    const saved = await expectOk(await saveAlias(db, { eventId, raw: "Visit SLO CAL", entityType: "supplier", entityId: slo.id, adminId }));
    expect(saved.imports).toEqual(expect.arrayContaining([{ importId, kind: "buyer_hotel_rankings", state: "ready" }]));
    expect((await getImport(importId, db))?.state).toBe("ready");

    const applied = await expectOk(await applyImport(db, { importId, adminId }));
    expect(applied.summary).toMatchObject({ rankingsWritten: 25, rankingsDeleted: 0, aliasesSaved: 1, optedIn: 0, optedOut: 0 });

    const rows = await rankingsFor(importId);
    expect(rows).toHaveLength(25);
    expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(rows.every((r) => !r.isRejection)).toBe(true);
    const ranker = await participantByEmail("test1@example.com");
    expect(rows.every((r) => r.rankerId === ranker.id && r.rankerType === "buyer" && r.targetType === "supplier")).toBe(true);
    expect(rows[23].targetId).toBe(slo.id);

    const [arrowhead] = await db.select().from(suppliers).where(eq(suppliers.name, "Lake Arrowhead Resort & Spa"));
    const autoAlias = await db
      .select()
      .from(nameAliases)
      .where(and(eq(nameAliases.rawText, "Lake Arrowhead Resort and Spa"), eq(nameAliases.eventId, eventId)));
    expect(autoAlias).toMatchObject([{ entityId: arrowhead.id, source: "auto" }]);
    const globalAuto = await db
      .select()
      .from(nameAliases)
      .where(and(eq(nameAliases.rawText, "Lake Arrowhead Resort and Spa"), isNull(nameAliases.eventId)));
    expect(globalAuto).toMatchObject([{ canonicalName: "Lake Arrowhead Resort & Spa", source: "auto" }]);
    expect(rows[13].targetId).toBe(arrowhead.id);
  });

  it("re-import replaces only the rankings of the people in the new file", async () => {
    // A one-row file for someone new adds their rankings and leaves everyone else's alone.
    const annOnly = await expectOk(await upload("buyer_hotel_rankings", listSheet([{ name: "Ann Lee", choices: ["The Ameswell Hotel"] }])));
    expect(annOnly.state).toBe("ready");
    expect(annOnly.report.warnings.map((w) => w.message)).toContain(
      "This file has rankings for 1 of 4 active participants. Everyone else keeps their current rankings.",
    );
    const first = await expectOk(await applyImport(db, { importId: annOnly.importId, adminId }));
    expect(first.summary).toMatchObject({ rankers: 1, rankingsDeleted: 0, rankingsWritten: 1 });
    expect(await rankingsFor(importId)).toHaveLength(25);

    // A one-row file for someone already ranked replaces only their rankings.
    const outcome = await expectOk(
      await upload("buyer_hotel_rankings", listSheet([{ name: "TestFirst1 TestLast1", choices: ["Visit SLO CAL", "See Monterey"] }])),
    );
    expect(outcome.state).toBe("ready");
    const applied = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    expect(applied.summary).toMatchObject({ rankers: 1, rankingsDeleted: 25, rankingsWritten: 2 });
    expect(await rankingsFor(importId)).toHaveLength(0);
    expect((await rankingsFor(outcome.importId)).map((r) => r.rank)).toEqual([1, 2]);
    expect(await rankingsFor(annOnly.importId)).toHaveLength(1);
    const hotelRankings = await db
      .select()
      .from(rankings)
      .where(and(eq(rankings.eventId, eventId), eq(rankings.rankerType, "buyer")));
    expect(hotelRankings).toHaveLength(3);
  });
});

describe("biztech rankings set opt-in (D1)", () => {
  it("opts in rankers with a choice and out the other participants in the file; people not in the file keep their flag", async () => {
    await db.update(participants).set({ biztechOptIn: true }).where(eq(participants.email, "bob@example.com"));
    const outcome = await expectOk(
      await upload(
        "buyer_biztech_rankings",
        listSheet([
          { name: "Ann Lee", choices: ["Dennison & Associates", "eshow"] },
          { name: "Bob Ray", choices: [] },
          { name: "Eve Kim", email: "eve@example.com", choices: ["SEAS Productions"] },
        ]),
      ),
    );
    expect(outcome.state).toBe("needs_mapping");
    expect(outcome.report.unknownNames.map((u) => u.raw)).toEqual(["eshow"]);
    expect(outcome.report.rowsWithZeroRankings).toEqual([{ row: 3, name: "Bob Ray (HelmsBriscoe)" }]);
    expect(outcome.report.warnings).toContainEqual({
      row: 3,
      message: "Bob Ray (HelmsBriscoe) has no choices in this file; their biztech rankings will be cleared.",
    });

    const [expo] = await db.select().from(suppliers).where(eq(suppliers.name, "Expo Convention Contractors"));
    await expectOk(await saveAlias(db, { eventId, raw: "eshow", entityType: "supplier", entityId: expo.id, adminId }));
    const applied = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    expect(applied.summary).toMatchObject({ rankers: 3, rankingsWritten: 3, optedIn: 2, optedOut: 1 });

    expect((await participantByEmail("ann@example.com")).biztechOptIn).toBe(true);
    expect((await participantByEmail("eve@example.com")).biztechOptIn).toBe(true);
    expect((await participantByEmail("bob@example.com")).biztechOptIn).toBe(false);
    // Not in the file: opted in by the participants file and still opted in.
    expect((await participantByEmail("test1@example.com")).biztechOptIn).toBe(true);
    // Withdrawn people are left alone.
    expect((await participantByEmail("dee@example.com")).biztechOptIn).toBe(true);
  });

  it("leaves opt-in alone when the event rule is all_opted_in", async () => {
    await db.update(events).set({ settings: { ...defaultEventSettings, biztechOptInRule: "all_opted_in" } }).where(eq(events.id, eventId));
    const outcome = await expectOk(await upload("buyer_biztech_rankings", listSheet([{ name: "Bob Ray", choices: ["SEAS Productions"] }])));
    const applied = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    // Bob chose nobody in the earlier file, so nothing of his is replaced; Ann's and Eve's rankings stay.
    expect(applied.summary).toMatchObject({ optedIn: 0, optedOut: 0, rankingsDeleted: 0, rankingsWritten: 1 });
    expect((await participantByEmail("bob@example.com")).biztechOptIn).toBe(false);
    const biztech = await db
      .select()
      .from(rankings)
      .innerJoin(imports, eq(rankings.importId, imports.id))
      .where(and(eq(rankings.eventId, eventId), eq(imports.kind, "buyer_biztech_rankings")));
    expect(biztech).toHaveLength(4);
    await db.update(events).set({ settings: defaultEventSettings }).where(eq(events.id, eventId));
  });
});

describe("supplier rankings in the 2025 matrix format (D18)", () => {
  it("resolves Organization - Title and company names, writes N/A as a rejection, and skips blanks (D2)", async () => {
    const outcome = await expectOk(
      await upload(
        "supplier_rankings",
        writeSheet(
          ["", "HelmsBriscoe - Senior Director", "Fox Travel", "TestFirst1 TestLast1", "Eve Kim"],
          [
            ["SEAS Productions", 1, "N/A", 2, ""],
            ["See Monterey", "", "", "", 1],
          ],
        ),
      ),
    );
    expect(outcome.report.format).toBe("matrix");
    // "Fox Travel" is Dee Fox's company and nobody else's, so it resolves without a mapping.
    expect(outcome.state).toBe("ready");
    expect(outcome.report.unknownNames).toEqual([]);

    const dee = await participantByEmail("dee@example.com");
    const applied = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    expect(applied.summary).toMatchObject({ rankingsWritten: 4 });

    const rows = await db.select().from(rankings).where(eq(rankings.importId, outcome.importId));
    const [seas] = await db.select().from(suppliers).where(eq(suppliers.name, "SEAS Productions"));
    const ann = await participantByEmail("ann@example.com");
    const rejection = rows.find((r) => r.targetId === dee.id);
    expect(rejection).toMatchObject({ rankerType: "supplier", rankerId: seas.id, targetType: "buyer", rank: null, isRejection: true });
    expect(rows.find((r) => r.targetId === ann.id)).toMatchObject({ rank: 1, isRejection: false });
    expect(rows.filter((r) => r.rankerId === seas.id)).toHaveLength(3);
  });
});

describe("queries and readiness", () => {
  it("lists imports newest first, picks the latest per kind, and reports readiness", async () => {
    const list = await listImports(eventId, db);
    expect(list.length).toBeGreaterThan(5);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(list[i].createdAt.getTime());
    }
    const byKind = await getImportStatusByKind(eventId, db);
    expect(byKind.participants?.state).toBe("failed");
    expect(byKind.suppliers?.state).toBe("applied");
    expect(byKind.supplier_rankings?.state).toBe("applied");

    const readiness = await matchingReadiness(db, eventId);
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual(["The latest participants upload failed validation. Fix or delete it."]);

    await deleteImportRecord(db, { importId: byKind.participants!.id, adminId });
    const [junk] = (await listImports(eventId, db)).filter((i) => i.kind === "participants" && i.state === "failed");
    await deleteImportRecord(db, { importId: junk.id, adminId });
    const [dupes] = (await listImports(eventId, db)).filter((i) => i.kind === "participants" && i.state === "needs_fixes");
    await deleteImportRecord(db, { importId: dupes.id, adminId });
    expect(await matchingReadiness(db, eventId)).toMatchObject({ ready: true, reasons: [] });
  });

  it("deleting an applied ranking import removes its rankings and its stored file", async () => {
    const byKind = await getImportStatusByKind(eventId, db);
    const target = byKind.supplier_rankings!;
    const [{ fileKey }] = await db.select({ fileKey: imports.fileKey }).from(imports).where(eq(imports.id, target.id));
    expect(await getFile(fileKey)).not.toBeNull();
    const result = await expectOk(await deleteImportRecord(db, { importId: target.id, adminId }));
    expect(result.rankingsDeleted).toBe(4);
    expect(await getImport(target.id, db)).toBeNull();
    expect(await getFile(fileKey)).toBeNull();
    expect((await getImportStatusByKind(eventId, db)).supplier_rankings).toBeNull();
  });
});

describe("applying a roster file re-checks pending ranking files", () => {
  it("turns a pending ranking import ready once the missing supplier is added", async () => {
    const pending = await expectOk(
      await upload("buyer_hotel_rankings", listSheet([{ name: "Ann Lee", choices: ["Brand New Inn"] }])),
    );
    expect(pending.state).toBe("needs_mapping");
    const roster = await expectOk(
      await upload("suppliers", writeSheet(supplierHeaders, [["Brand New Inn", "hotel", "", "", "", ""]])),
    );
    await expectOk(await applyImport(db, { importId: roster.importId, adminId }));
    expect((await getImport(pending.importId, db))?.state).toBe("ready");
    await deleteImportRecord(db, { importId: pending.importId, adminId });
  });
});

describe("saving several aliases at once", () => {
  it("is all or nothing and re-validates the pending import once", async () => {
    const outcome = await expectOk(
      await upload("supplier_rankings", listSheet([{ name: "See Monterey", choices: ["Annie Lee", "Robert Ray"] }])),
    );
    expect(outcome.state).toBe("needs_mapping");
    expect(outcome.report.unknownNames.map((n) => n.raw).sort()).toEqual(["Annie Lee", "Robert Ray"]);
    const [ann, bob] = [await participantByEmail("ann@example.com"), await participantByEmail("bob@example.com")];

    const refused = await saveAliases(db, {
      eventId,
      adminId,
      aliases: [
        { raw: "Annie Lee", entityType: "buyer", entityId: ann.id },
        { raw: "Robert Ray", entityType: "buyer", entityId: "00000000-0000-4000-8000-000000000000" },
      ],
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await db.select().from(nameAliases).where(eq(nameAliases.rawText, "Annie Lee"))).toHaveLength(0);

    const saved = await expectOk(
      await saveAliases(db, {
        eventId,
        adminId,
        aliases: [
          { raw: " Annie Lee ", entityType: "buyer", entityId: ann.id },
          { raw: "Robert Ray", entityType: "buyer", entityId: bob.id },
        ],
      }),
    );
    expect(saved.aliasIds).toHaveLength(2);
    expect(saved.imports).toEqual(expect.arrayContaining([{ importId: outcome.importId, kind: "supplier_rankings", state: "ready" }]));
    await deleteImportRecord(db, { importId: outcome.importId, adminId });
  });
});

describe("cross-year aliases (D76)", () => {
  it("resolve a name mapped in one event in the next event, through the canonical name", async () => {
    const [nextYear] = await db
      .insert(events)
      .values({ name: "AW 2027", eventDate: "2027-11-09", timezone: "America/Los_Angeles", settings: defaultEventSettings })
      .returning();
    await expectOk(
      await upload(
        "suppliers",
        writeSheet(supplierHeaders, [["visit san luis obispo county (slo cal)", "hotel", "", "", "", ""]]),
        "suppliers-2027.xlsx",
        nextYear.id,
      ),
    ).then((outcome) => applyImport(db, { importId: outcome.importId, adminId }));
    await expectOk(
      await upload("participants", writeSheet(participantHeaders, [["ann@example.com", "Ann", "Lee", "", "", ""]]), "p.xlsx", nextYear.id),
    ).then((outcome) => applyImport(db, { importId: outcome.importId, adminId }));

    // "Visit SLO CAL" was mapped by hand in AW 2026 above. AW 2027 has no event alias for it.
    const outcome = await expectOk(
      await upload("buyer_hotel_rankings", listSheet([{ name: "Ann Lee", choices: ["visit slo cal"] }]), "r.xlsx", nextYear.id),
    );
    expect(outcome.report.unknownNames).toEqual([]);
    expect(outcome.state).toBe("ready");
    const applied = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    const [slo2027] = await db.select().from(suppliers).where(eq(suppliers.eventId, nextYear.id));
    const [row] = await rankingsFor(outcome.importId);
    expect(applied.summary.rankingsWritten).toBe(1);
    expect(row.targetId).toBe(slo2027.id);

    const globals = await db.select().from(nameAliases).where(and(isNull(nameAliases.eventId), eq(nameAliases.rawText, "Visit SLO CAL")));
    expect(globals).toMatchObject([{ entityType: "supplier", canonicalName: "Visit San Luis Obispo County (SLO CAL)", source: "manual" }]);
    await db.delete(events).where(eq(events.id, nextYear.id));
  });
});

describe("applying the same import twice at once", () => {
  it("applies once and returns a conflict for the other", async () => {
    const outcome = await expectOk(
      await upload("suppliers", writeSheet(supplierHeaders, [["Twice Inn", "hotel", "", "", "", ""]])),
    );
    const results = await Promise.all([
      applyImport(db, { importId: outcome.importId, adminId }),
      applyImport(db, { importId: outcome.importId, adminId }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ ok: false, error: { code: "conflict" } }]);
    const applyRows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "import.apply"), eq(auditEvents.entityId, outcome.importId)));
    expect(applyRows).toHaveLength(1);
  });
});

describe("locked events", () => {
  it("refuse uploads, aliases, applies, and deletes", async () => {
    const pending = await expectOk(await upload("supplier_rankings", listSheet([{ name: "See Monterey", choices: ["Ann Lee"] }])));
    await db.update(events).set({ status: "locked" }).where(eq(events.id, eventId));
    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.name, "See Monterey"));
    const results = await Promise.all([
      upload("participants", writeSheet(participantHeaders, [["x@example.com", "X", "Y", "", "", ""]])),
      saveAlias(db, { eventId, raw: "Monterey", entityType: "supplier", entityId: supplier.id, adminId }),
      applyImport(db, { importId: pending.importId, adminId }),
      deleteImportRecord(db, { importId: pending.importId, adminId }),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: "locked" } });
    await db.update(events).set({ status: "draft" }).where(eq(events.id, eventId));
  });

  it("wrote an audit row for every import mutation", async () => {
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.eventId, eventId));
    const actions = new Set(audit.map((a) => a.action));
    expect([...actions].sort()).toEqual(["alias.save", "import.apply", "import.create", "import.delete"]);
    const applyRows = audit.filter((a) => a.action === "import.apply");
    const stillApplied = await db.select().from(imports).where(eq(imports.status, "applied"));
    // One applied import (supplier rankings) was deleted above; its apply row stays in the log.
    expect(applyRows.length).toBe(stillApplied.length + 1);
  });
});

describe("applies and revalidation under the event row lock (D85)", () => {
  let raceEvent: string;

  beforeAll(async () => {
    const [event] = await db
      .insert(events)
      .values({ name: "AW race", eventDate: "2026-11-10", timezone: "America/Los_Angeles", settings: defaultEventSettings, status: "imported" })
      .returning();
    raceEvent = event.id;
    await db.insert(participants).values({ eventId: raceEvent, email: "ann@race.example.com", firstName: "Ann", lastName: "Lee" });
    await db.insert(suppliers).values([
      { eventId: raceEvent, name: "Hotel One", type: "hotel" },
      { eventId: raceEvent, name: "Hotel Two", type: "hotel" },
    ]);
  });

  const hotelFile = (choices: string[]) =>
    upload("buyer_hotel_rankings", listSheet([{ name: "Ann Lee", email: "ann@race.example.com", choices }]), "hotels.xlsx", raceEvent);

  it("two ranking applies at once leave only the later one's rankings", async () => {
    const first = await expectOk(await hotelFile(["Hotel One", "Hotel Two"]));
    const second = await expectOk(await hotelFile(["Hotel Two"]));
    expect([first.state, second.state]).toEqual(["ready", "ready"]);
    const results = await Promise.all([
      applyImport(db, { importId: first.importId, adminId }),
      applyImport(db, { importId: second.importId, adminId }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const applied = await db.select().from(imports).where(eq(imports.eventId, raceEvent));
    const later = [...applied].sort((a, b) => b.appliedAt!.getTime() - a.appliedAt!.getTime())[0];
    const left = await db.select().from(rankings).where(eq(rankings.eventId, raceEvent));
    expect(left.length).toBeGreaterThan(0);
    expect(new Set(left.map((r) => r.importId))).toEqual(new Set([later.id]));
  });

  it("an apply refuses when the event was locked after its check, and writes nothing", async () => {
    const pending = await expectOk(await hotelFile(["Hotel One"]));
    const before = await db.select().from(rankings).where(eq(rankings.eventId, raceEvent));
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, raceEvent));
    const result = await applyImport(raceBeforeTransaction(db, lock), { importId: pending.importId, adminId });
    expect(result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect((await getImport(pending.importId, db))?.status).toBe("validated");
    expect(await db.select().from(rankings).where(eq(rankings.eventId, raceEvent))).toEqual(before);
    await db.update(events).set({ status: "imported" }).where(eq(events.id, raceEvent));
  });

  it("revalidation leaves an import applied since it was read alone", async () => {
    const pending = await expectOk(await hotelFile(["Hotel Two", "Hotel One"]));
    const [stale] = await db.select().from(imports).where(eq(imports.id, pending.importId));
    await expectOk(await applyImport(db, { importId: pending.importId, adminId }));
    expect(await revalidateImport(db, stale)).toBeNull();
    expect((await getImport(pending.importId, db))?.status).toBe("applied");
  });

  describe("a check that finishes after another admin mapped a name", () => {
    let gamma: string;

    beforeAll(async () => {
      const [supplier] = await db.insert(suppliers).values({ eventId: raceEvent, name: "Hotel Gamma", type: "hotel" }).returning();
      gamma = supplier.id;
    });

    const mapName = (raw: string) => () => saveAlias(db, { eventId: raceEvent, raw, entityType: "supplier", entityId: gamma, adminId });

    it("never overwrites the newer report on a revalidation", async () => {
      const pending = await expectOk(await hotelFile(["Grand Place"]));
      expect(pending.state).toBe("needs_mapping");
      const [stale] = await db.select().from(imports).where(eq(imports.id, pending.importId));
      // The other admin's mapping lands after this one read the import and before it writes.
      const state = await revalidateImport(raceBeforeTransaction(db, mapName("Grand Place")), stale);
      expect(state).toBe("ready");
      expect((await getImport(pending.importId, db))?.state).toBe("ready");
    });

    it("never overwrites the newer report when an ignored file is checked again", async () => {
      const pending = await expectOk(await hotelFile(["Gran Plaza"]));
      await expectOk(await ignoreImport(db, { importId: pending.importId, adminId }));
      const result = await stopIgnoringImport(raceBeforeTransaction(db, mapName("Gran Plaza")), { importId: pending.importId, adminId });
      expect(await expectOk(result)).toMatchObject({ state: "ready" });
      expect((await getImport(pending.importId, db))?.state).toBe("ready");
    });
  });

  it("revalidation after the event is archived leaves the report as it was", async () => {
    const pending = await expectOk(await hotelFile(["Hotel Four"]));
    expect(pending.state).toBe("needs_mapping");
    const [stale] = await db.select().from(imports).where(eq(imports.id, pending.importId));
    // Would make the file ready, if revalidation still wrote.
    await db.insert(suppliers).values({ eventId: raceEvent, name: "Hotel Four", type: "hotel" });
    await db.update(events).set({ status: "archived" }).where(eq(events.id, raceEvent));
    expect(await revalidateImport(db, stale)).toBeNull();
    const [after] = await db.select().from(imports).where(eq(imports.id, pending.importId));
    expect(after.validation).toEqual(stale.validation);
    expect((await getImport(pending.importId, db))?.state).toBe("needs_mapping");
    await db.update(events).set({ status: "imported" }).where(eq(events.id, raceEvent));
    expect(await revalidateImport(db, stale)).toBe("ready");
  });

  it("an apply refused as invalid leaves the report of an apply that won the race alone", async () => {
    const pending = await expectOk(await hotelFile(["Hotel Three"]));
    expect(pending.state).toBe("needs_mapping");
    // After the refused apply checked the file: the supplier arrives and another admin applies it.
    const otherApply = async () => {
      await db.insert(suppliers).values({ eventId: raceEvent, name: "Hotel Three", type: "hotel" });
      await expectOk(await applyImport(db, { importId: pending.importId, adminId }));
    };
    const refused = await applyImport(raceBeforeTransaction(db, otherApply), { importId: pending.importId, adminId });
    expect(refused).toMatchObject({ ok: false, error: { code: "validation" } });
    const applied = await getImport(pending.importId, db);
    expect(applied).toMatchObject({ status: "applied", state: "applied" });
    expect(applied?.report?.counts.unknownNames).toBe(0);
  });
});

describe("a failed upload leaves no stored file", () => {
  const sheet = () => writeSheet(supplierHeaders, [["Cleanup Inn", "hotel", "", "", "", ""]]);

  async function uploadWithKnownKey(target: Db) {
    const importId = "00000000-0000-4000-8000-00000000c1ea";
    vi.mocked(randomUUID).mockReturnValueOnce(importId);
    const key = importFileKey(eventId, importId, "cleanup.xlsx");
    const result = createImport(target, { eventId, kind: "suppliers", filename: "cleanup.xlsx", buffer: sheet(), adminId });
    return { importId, key, result };
  }

  it("when the event is locked while the file is parsed", async () => {
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, eventId));
    const { importId, key, result } = await uploadWithKnownKey(raceBeforeTransaction(db, lock));
    expect(await result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect(await getFile(key)).toBeNull();
    expect(await getImport(importId, db)).toBeNull();
    await db.update(events).set({ status: "draft" }).where(eq(events.id, eventId));
  });

  it("when the event is locked and the stored file can't be deleted, the key is logged and the conflict still returns", async () => {
    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, eventId));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const realDelete = vi.mocked(deleteFile).getMockImplementation()!;
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error("storage is down"));
    try {
      const { importId, key, result } = await uploadWithKnownKey(raceBeforeTransaction(db, lock));
      expect(await result).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
      expect(await getImport(importId, db)).toBeNull();
      // The failed delete is neither thrown nor lost: the log names the import and the key to clean up by hand.
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain(importId);
      expect(message).toContain(key);
      expect(message).toContain("storage is down");
      expect(await getFile(key)).not.toBeNull();
      await realDelete(key);
    } finally {
      warn.mockRestore();
      await db.update(events).set({ status: "draft" }).where(eq(events.id, eventId));
    }
  });

  it("when saving the import throws", async () => {
    const broken = () => Promise.reject(new Error("connection lost"));
    const { importId, key, result } = await uploadWithKnownKey(raceBeforeTransaction(db, broken));
    await expect(result).rejects.toThrow("connection lost");
    expect(await getFile(key)).toBeNull();
    expect(await getImport(importId, db)).toBeNull();
  });
});
