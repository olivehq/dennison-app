import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { admins, auditEvents, events, nameAliases, rankings, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas";
import type { ImportKind } from "@/lib/schemas/import";
import { useMemoryStorageForTests } from "@/lib/storage";
import { raceBeforeTransaction } from "@/server/events/test-race";
import { writeSheet } from "@/lib/xlsx";
import { applyImport, createImport, recheckImport, removeAlias, reportIsStale, saveAliases } from "./imports";
import { getImport, listSavedNameMappings } from "./queries";
import { templateWorkbook } from "./templates";

// Browser walkthrough, Oct 29 2026, with the shapes of the VLD test event
// files: a hotel rankings file naming 13 hotels, a first suppliers file with
// 4 of them, and a second suppliers file with all 13. People are invented.

let db: Db;
const adminId = "admin-1";

const participantHeaders = ["Email", "First name", "Last name", "Organization", "Title", "Biztech opt-in"];
const supplierHeaders = ["Name", "Type", "Admin contact name", "Admin contact email", "Attendee contact name", "Attendee contact email"];

/** The hotel file's choices, in CHOICE #1 to #13 order. */
const HOTEL_CHOICES = [
  "20 Hotel", "130 Hotel", "210 Hotel", "200 Hotel", "80 Hotel", "140 Hotel", "100 Hotel",
  "110 Hotel", "40 Hotel", "30 Hotel", "10 Hotel", "90 Hotel", "120 Hotel",
];
const EXPECTED_RANKS = Object.fromEntries(HOTEL_CHOICES.map((name, i) => [name, i + 1]));
const SUPPLIERS_1 = [...["10", "20", "30", "40"].map((n) => `${n} Hotel`), "50 Business", "60 Business", "70 Business"];
const SUPPLIERS_2 = [...new Set([...HOTEL_CHOICES, ...SUPPLIERS_1, "150 Business", "160 Business"])];

function supplierSheet(names: string[]): Buffer {
  return writeSheet(supplierHeaders, names.map((name) => [name, name.endsWith("Hotel") ? "Hotel" : "Business", "", "", "", ""]));
}

const participantFile = writeSheet(participantHeaders, [
  ["pat.kim@example.com", "Pat", "Kim", "Example Meetings Co", "Meeting planner", "yes"],
]);

function hotelSheet(choices: string[] = HOTEL_CHOICES): Buffer {
  const headers = ["FIRST_NAME", "LAST_NAME", "FULL_NAME", "EMAIL", ...choices.map((_, i) => `CHOICE #${i + 1}`)];
  return writeSheet(headers, [["Pat", "Kim", "Pat Kim", "pat.kim@example.com", ...choices]]);
}

async function expectOk<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): Promise<T> {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

async function makeEvent(name: string): Promise<string> {
  const [event] = await db
    .insert(events)
    .values({ name, eventDate: "2026-12-04", timezone: "America/Los_Angeles", settings: defaultEventSettings })
    .returning();
  return event.id;
}

async function uploadAndApply(eventId: string, kind: ImportKind, buffer: Buffer): Promise<string> {
  const { importId, state } = await expectOk(await createImport(db, { eventId, kind, filename: `${kind}.xlsx`, buffer, adminId }));
  expect(state).toBe("ready");
  await expectOk(await applyImport(db, { importId, adminId }));
  return importId;
}

async function uploadHotels(eventId: string, buffer = hotelSheet()) {
  return expectOk(await createImport(db, { eventId, kind: "buyer_hotel_rankings", filename: "TEST_AW_buyer_hotel_rankings_update.xlsx", buffer, adminId }));
}

/** Supplier name to the rank the buyer gave it, as stored. */
async function storedRanks(eventId: string): Promise<Record<string, number | null>> {
  const rows = await db
    .select({ name: suppliers.name, rank: rankings.rank })
    .from(rankings)
    .innerJoin(suppliers, eq(rankings.targetId, suppliers.id))
    .where(eq(rankings.eventId, eventId));
  return Object.fromEntries(rows.map((row) => [row.name, row.rank]));
}

async function supplierId(eventId: string, name: string): Promise<string> {
  const [row] = await db.select({ id: suppliers.id }).from(suppliers).where(and(eq(suppliers.eventId, eventId), eq(suppliers.name, name)));
  return row.id;
}

beforeAll(async () => {
  useMemoryStorageForTests();
  db = await createTestDb();
  await db.insert(admins).values({ id: adminId, name: "Admin", email: "admin@example.com" });
});

describe("loading a ranking file before its suppliers", () => {
  it("suggests no hotel whose number differs, then the suppliers apply re-checks the file and every rank lands on its hotel", async () => {
    const eventId = await makeEvent("Rankings first");
    await uploadAndApply(eventId, "participants", participantFile);
    await uploadAndApply(eventId, "suppliers", supplierSheet(SUPPLIERS_1));

    const hotels = await uploadHotels(eventId);
    expect(hotels.state).toBe("needs_mapping");
    expect(hotels.report.unknownNames.map((name) => name.raw).sort()).toEqual(
      HOTEL_CHOICES.filter((name) => !SUPPLIERS_1.includes(name)).sort(),
    );
    // "100 Hotel" is not "10 Hotel": nothing is suggested for any of them.
    expect(hotels.report.unknownNames.flatMap((name) => name.suggestions)).toEqual([]);

    // D48: applying the suppliers file checks the pending ranking file again.
    await uploadAndApply(eventId, "suppliers", supplierSheet(SUPPLIERS_2));
    const rechecked = await getImport(hotels.importId, db);
    expect(rechecked?.state).toBe("ready");
    expect(rechecked?.report?.warnings.filter((w) => w.message.includes("more than once") || w.message.includes("times:"))).toEqual([]);

    await expectOk(await applyImport(db, { importId: hotels.importId, adminId }));
    expect(await storedRanks(eventId)).toEqual(EXPECTED_RANKS);
  });
});

describe("saved mappings and names on the roster", () => {
  it("never lets a wrong saved mapping beat a hotel's own name, in this event or the next", async () => {
    const first = await makeEvent("Wrong mappings");
    await uploadAndApply(first, "participants", participantFile);
    await uploadAndApply(first, "suppliers", supplierSheet(SUPPLIERS_1));
    const hotels = await uploadHotels(first);
    // The walkthrough's mistake, made by hand: two hotels mapped to the wrong one.
    await expectOk(
      await saveAliases(db, {
        eventId: first,
        adminId,
        aliases: [
          { raw: "100 Hotel", entityType: "supplier", entityId: await supplierId(first, "10 Hotel") },
          { raw: "200 Hotel", entityType: "supplier", entityId: await supplierId(first, "20 Hotel") },
        ],
      }),
    );
    const mapped = await getImport(hotels.importId, db);
    expect(mapped?.report?.aliasedNames?.map((name) => [name.raw, name.name, name.scope])).toEqual([
      ["100 Hotel", "10 Hotel", "event"],
      ["200 Hotel", "20 Hotel", "event"],
    ]);
    // One warning per supplier listed twice, quoting the text in the file.
    expect(mapped?.report?.warnings.map((w) => w.message)).toContain(
      'Pat Kim (Example Meetings Co) lists 10 Hotel 2 times: "100 Hotel" (choice 7), "10 Hotel" (choice 11). Only choice 7 is kept.',
    );

    await uploadAndApply(first, "suppliers", supplierSheet(SUPPLIERS_2));
    const rechecked = await getImport(hotels.importId, db);
    expect(rechecked?.state).toBe("ready");
    expect(rechecked?.report?.aliasedNames).toEqual([]);
    await expectOk(await applyImport(db, { importId: hotels.importId, adminId }));
    expect(await storedRanks(first)).toEqual(EXPECTED_RANKS);

    // The next event, loaded in the right order, reads every name as itself despite the cross-year copies.
    const next = await makeEvent("Clean order");
    await uploadAndApply(next, "participants", participantFile);
    await uploadAndApply(next, "suppliers", supplierSheet(SUPPLIERS_2));
    const clean = await uploadHotels(next);
    expect(clean.state).toBe("ready");
    expect(clean.report.aliasedNames).toEqual([]);
    await expectOk(await applyImport(db, { importId: clean.importId, adminId }));
    expect(await storedRanks(next)).toEqual(EXPECTED_RANKS);
  });

  it("lists the mappings that apply here and removes them with an audit row and a re-check", async () => {
    const eventId = await makeEvent("Removing mappings");
    await uploadAndApply(eventId, "participants", participantFile);
    await uploadAndApply(eventId, "suppliers", supplierSheet(SUPPLIERS_1));
    const hotels = await uploadHotels(eventId);
    // A manual save replaces the cross-year "200 Hotel" copy the last test wrote.
    await expectOk(
      await saveAliases(db, {
        eventId,
        adminId,
        aliases: [{ raw: "200 Hotel", entityType: "supplier", entityId: await supplierId(eventId, "20 Hotel") }],
      }),
    );

    const listed = await listSavedNameMappings(eventId, db);
    expect(listed.map((m) => [m.rawText, m.mapsTo, m.scope, m.crossYear])).toEqual([
      // Saved in the last test's event; applies here because a "10 Hotel" is on this roster.
      ["100 Hotel", "10 Hotel", "cross_year", true],
      ["200 Hotel", "20 Hotel", "event", true],
    ]);
    const [crossYear, own] = listed;

    const removedOwn = await expectOk(await removeAlias(db, { eventId, aliasId: own.id, adminId }));
    expect(removedOwn.imports.find((entry) => entry.importId === hotels.importId)?.state).toBe("needs_mapping");
    // The event alias and the cross-year copy it wrote are both gone.
    const left200 = await db.select().from(nameAliases).where(eq(nameAliases.rawText, "200 Hotel"));
    expect(left200.filter((row) => row.eventId === eventId || row.eventId === null)).toEqual([]);

    await expectOk(await removeAlias(db, { eventId, aliasId: crossYear.id, adminId }));
    expect(await db.select().from(nameAliases).where(and(isNull(nameAliases.eventId), eq(nameAliases.rawText, "100 Hotel")))).toEqual([]);
    expect(await listSavedNameMappings(eventId, db)).toEqual([]);
    expect((await getImport(hotels.importId, db))?.report?.unknownNames.map((name) => name.raw)).toContain("100 Hotel");

    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.eventId, eventId), eq(auditEvents.action, "alias.remove")));
    expect(audit.map((row) => row.before)).toEqual([
      expect.objectContaining({ raw: "200 Hotel", mapsTo: "20 Hotel", scope: "event", crossYear: true, source: "manual" }),
      expect.objectContaining({ raw: "100 Hotel", mapsTo: "10 Hotel", scope: "cross_year" }),
    ]);
    expect(audit.every((row) => row.adminId === adminId)).toBe(true);

    // Removed twice: the second one is refused, not an error.
    expect(await removeAlias(db, { eventId, aliasId: own.id, adminId })).toEqual({
      ok: false,
      error: { code: "not_found", message: "That saved name is already gone. Reload the page." },
    });

    // Gone already, or an alias of another event: refused.
    expect(await removeAlias(db, { eventId, aliasId: own.id, adminId })).toMatchObject({ ok: false, error: { code: "not_found" } });

    // A locked event refuses the removal.
    await expectOk(
      await saveAliases(db, {
        eventId,
        adminId,
        aliases: [{ raw: "80 Hotel", entityType: "supplier", entityId: await supplierId(eventId, "40 Hotel") }],
      }),
    );
    const [eighty] = await listSavedNameMappings(eventId, db);
    await db.update(events).set({ status: "locked" }).where(eq(events.id, eventId));
    expect(await removeAlias(db, { eventId, aliasId: eighty.id, adminId })).toMatchObject({ ok: false, error: { code: "locked" } });
  });
});

describe("ranking file checks", () => {
  it("refuses a hotel file uploaded on the biztech card", async () => {
    const eventId = await makeEvent("Wrong ranking card");
    await uploadAndApply(eventId, "participants", participantFile);
    await uploadAndApply(eventId, "suppliers", supplierSheet(SUPPLIERS_2));
    const outcome = await expectOk(
      await createImport(db, { eventId, kind: "buyer_biztech_rankings", filename: "rankings.xlsx", buffer: hotelSheet(), adminId }),
    );
    expect(outcome.state).toBe("needs_fixes");
    expect(outcome.report.errors.map((e) => e.message)).toContain(
      "Every choice in this file is a hotel supplier. This looks like a buyer hotel rankings file. Upload it on the Buyer hotel rankings card.",
    );
  });
});

describe("template example rows", () => {
  it("are refused in participants and suppliers files, so they never become real people", async () => {
    const eventId = await makeEvent("Example rows");
    for (const kind of ["participants", "suppliers"] as const) {
      const outcome = await expectOk(
        await createImport(db, { eventId, kind, filename: `${kind}.xlsx`, buffer: templateWorkbook(kind), adminId }),
      );
      expect(outcome.state).toBe("needs_fixes");
      expect(outcome.report.errors).toContainEqual({
        row: 2,
        message: "This is the template's example row. Delete it, then upload the file again.",
      });
    }
  });
});

describe("template example rows in ranking files", () => {
  it("are refused on their row and leave no example names to map", async () => {
    const eventId = await makeEvent("Example ranking rows");
    for (const kind of ["buyer_biztech_rankings", "buyer_hotel_rankings", "supplier_rankings"] as const) {
      const outcome = await expectOk(
        await createImport(db, { eventId, kind, filename: `${kind}.xlsx`, buffer: templateWorkbook(kind), adminId }),
      );
      expect(outcome.state).toBe("needs_fixes");
      expect(outcome.report.errors).toContainEqual({
        row: 2,
        message: "This is the template's example row. Delete it, then upload the file again.",
      });
      expect(outcome.report.unknownNames).toEqual([]);
    }
  });
});

describe("report order", () => {
  it("lists errors by row, the ones about the whole file last", async () => {
    const eventId = await makeEvent("Error order");
    const outcome = await expectOk(
      await createImport(db, {
        eventId,
        kind: "suppliers",
        filename: "suppliers.xlsx",
        buffer: writeSheet(supplierHeaders, [
          ["Dup Hotel", "hotel", "", "", "", ""],
          ["Bad Type", "spa", "", "", "", ""],
          ["Dup Hotel", "hotel", "", "", "", ""],
          ["Also Bad", "spa", "", "", "", ""],
        ]),
        adminId,
      }),
    );
    const rows = outcome.report.errors.map((e) => e.row);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows).toEqual([...rows].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)));
  });
});

describe("a report made before the roster changed", () => {
  it("is stale once a supplier gains the exact name of a mapped text, and fresh again after a re-check", async () => {
    const eventId = await makeEvent("Stale report");
    await uploadAndApply(eventId, "participants", participantFile);
    await uploadAndApply(eventId, "suppliers", supplierSheet(["Harbor Resort"]));
    const hotels = await uploadHotels(eventId, hotelSheet(["Harbour Resort"]));
    expect(hotels.state).toBe("needs_mapping");
    expect(await reportIsStale(db, hotels.importId)).toBe(false);

    await expectOk(
      await saveAliases(db, {
        eventId,
        adminId,
        aliases: [{ raw: "Harbour Resort", entityType: "supplier", entityId: await supplierId(eventId, "Harbor Resort") }],
      }),
    );
    expect(await reportIsStale(db, hotels.importId)).toBe(false);

    await db.insert(suppliers).values({ eventId, name: "Harbour Resort", type: "hotel" });
    expect(await reportIsStale(db, hotels.importId)).toBe(true);

    const rechecked = await expectOk(await recheckImport(db, { importId: hotels.importId }));
    expect(rechecked.state).toBe("ready");
    expect(await reportIsStale(db, hotels.importId)).toBe(false);
  });

  it("can't be checked again once applied", async () => {
    const eventId = await makeEvent("Recheck applied");
    await uploadAndApply(eventId, "participants", participantFile);
    await uploadAndApply(eventId, "suppliers", supplierSheet(HOTEL_CHOICES));
    const importId = await uploadAndApply(eventId, "buyer_hotel_rankings", hotelSheet());
    expect(await reportIsStale(db, importId)).toBe(false);
    expect(await recheckImport(db, { importId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("roster file changes", () => {
  it("says which fields change for whom, who loses an organization or title, and who isn't in the file", async () => {
    const eventId = await makeEvent("Roster changes");
    await uploadAndApply(
      eventId,
      "participants",
      writeSheet(participantHeaders, [
        ["pat.kim@example.com", "Pat", "Kim", "Example Meetings Co", "Meeting planner", "yes"],
        ["sam.lee@example.com", "Sam", "Lee", "Example Travel", "Director", "no"],
        ["ann.ray@example.com", "Ann", "Ray", "Example Events", "Planner", ""],
        ["kim.fox@example.com", "Kim", "Fox", "", "", ""],
      ]),
    );
    const next = await expectOk(
      await createImport(db, {
        eventId,
        kind: "participants",
        filename: "participants_2.xlsx",
        buffer: writeSheet(participantHeaders, [
          ["pat.kim@example.com", "Pat", "Kim", "Example Meetings Co", "", ""],
          ["sam.lee@example.com", "Sam", "Lee", "Example Travel", "Vice president", "yes"],
          ["kim.fox@example.com", "Kim", "Fox", "", "", ""],
          ["new.person@example.com", "New", "Person", "Example Co", "Owner", "yes"],
        ]),
        adminId,
      }),
    );
    expect(next.report.rosterChanges).toEqual({
      updated: 2,
      unchanged: 1,
      fields: [
        { field: "Title", count: 2, names: ["Pat Kim", "Sam Lee"] },
        { field: "Biztech opt-in", count: 1, names: ["Sam Lee"] },
      ],
      cleared: [{ name: "Pat Kim", fields: ["title"] }],
      missing: ["Ann Ray"],
    });
    expect(next.report.warnings.map((w) => w.message)).toEqual([
      "Pat Kim has an organization and a title on the roster. Applying this file clears their title.",
      "1 participant on the roster is not in this file and will be kept as is: Ann Ray.",
    ]);

    await uploadAndApply(eventId, "suppliers", supplierSheet(["10 Hotel", "50 Business"]));
    const suppliersNext = await expectOk(
      await createImport(db, {
        eventId,
        kind: "suppliers",
        filename: "suppliers_2.xlsx",
        buffer: writeSheet(supplierHeaders, [["10 Hotel", "Hotel", "Ana Ruiz", "ana@example.com", "", ""]]),
        adminId,
      }),
    );
    expect(suppliersNext.report.rosterChanges).toMatchObject({
      updated: 1,
      fields: [
        { field: "Admin contact name", count: 1, names: ["10 Hotel"] },
        { field: "Admin contact email", count: 1, names: ["10 Hotel"] },
      ],
      missing: ["50 Business"],
    });
  });
  it("applies with the mappings as they are under the event lock, so a mapping removed just before apply is not used", async () => {
    const eventId = await makeEvent("Remove during apply");
    await uploadAndApply(eventId, "participants", participantFile);
    await uploadAndApply(eventId, "suppliers", supplierSheet(SUPPLIERS_1));
    const hotels = await uploadHotels(eventId, hotelSheet(["10 Hotel", "999 Hotel"]));
    expect(hotels.state).toBe("needs_mapping");
    await expectOk(
      await saveAliases(db, {
        eventId,
        adminId,
        aliases: [{ raw: "999 Hotel", entityType: "supplier", entityId: await supplierId(eventId, "20 Hotel") }],
      }),
    );
    const [mapping] = (await listSavedNameMappings(eventId, db)).filter((m) => m.rawText === "999 Hotel");

    // Another admin removes the mapping after this apply read the import but before it took the lock.
    const raced = raceBeforeTransaction(db, () => removeAlias(db, { eventId, aliasId: mapping.id, adminId }));
    const result = await applyImport(raced, { importId: hotels.importId, adminId });
    expect(result).toEqual({ ok: false, error: { code: "validation", message: "Map every unknown name before applying this file." } });
    expect(await storedRanks(eventId)).toEqual({});
  });
});
