import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { admins, auditEvents, events, imports, nameAliases, participants, rankings, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { defaultEventSettings } from "@/lib/schemas";
import type { ImportKind } from "@/lib/schemas/import";
import { useMemoryStorageForTests } from "@/lib/storage";
import { writeSheet } from "@/lib/xlsx";
import { EVENT_CHANGED_MESSAGE } from "@/server/events/editable";
import { raceBeforeTransaction } from "@/server/events/test-race";
import {
  applyImport,
  createImport,
  deleteImportRecord,
  ignoreImport,
  saveAliases,
  stopIgnoringImport,
} from "./imports";
import { matchingReadiness } from "@/server/matching/readiness";
import { countRankingsToReplace, getImport, getImportStatusByKind } from "./queries";

// Client feedback, Oct 15 2026. The roster mirrors the VLD test event files
// (two David Smiths at GHI Association with different emails), with the
// emails replaced by example.com ones.

let db: Db;
const adminId = "admin-1";

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

async function expectOk<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): Promise<T> {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

type Roster = { eventId: string; ids: Record<string, string> };

/** A fresh event: five buyers (two David Smiths at one company), three hotels, two business suppliers. */
async function makeEvent(name: string): Promise<Roster> {
  const [event] = await db
    .insert(events)
    .values({ name, eventDate: "2026-11-10", timezone: "America/Los_Angeles", settings: defaultEventSettings, status: "imported" })
    .returning();
  const people = await db
    .insert(participants)
    .values([
      { eventId: event.id, email: "jdoe@example.com", firstName: "Jane", lastName: "Doe", organization: "ABC Association", title: "Executive Director", biztechOptIn: true },
      { eventId: event.id, email: "fschmoe@example.com", firstName: "Frank", lastName: "Schmoe", organization: "DEF Association", title: "Executive Director" },
      { eventId: event.id, email: "dsmith1@example.com", firstName: "David", lastName: "Smith", organization: "GHI Association", title: "Meeting Planner" },
      { eventId: event.id, email: "dsmith2@example.com", firstName: "David", lastName: "Smith", organization: "GHI Association", title: "Meeting Planner" },
      { eventId: event.id, email: "cbrown@example.com", firstName: "Chris", lastName: "Brown", organization: "LMN Association", title: "Executive Director", biztechOptIn: true },
    ])
    .returning();
  const companies = await db
    .insert(suppliers)
    .values([
      { eventId: event.id, name: "10 Hotel", type: "hotel" as const },
      { eventId: event.id, name: "20 Hotel", type: "hotel" as const },
      { eventId: event.id, name: "30 Hotel", type: "hotel" as const },
      { eventId: event.id, name: "Biz One", type: "business" as const },
      { eventId: event.id, name: "Biz Two", type: "business" as const },
    ])
    .returning();
  const ids: Record<string, string> = {};
  for (const person of people) ids[person.email] = person.id;
  for (const company of companies) ids[company.name] = company.id;
  return { eventId: event.id, ids };
}

function upload(roster: Roster, kind: ImportKind, buffer: Buffer, filename = `${kind}.xlsx`) {
  return createImport(db, { eventId: roster.eventId, kind, filename, buffer, adminId });
}

async function uploadAndApply(roster: Roster, kind: ImportKind, buffer: Buffer) {
  const outcome = await expectOk(await upload(roster, kind, buffer));
  expect(outcome.state).toBe("ready");
  const applied = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
  return { importId: outcome.importId, report: outcome.report, summary: applied.summary };
}

async function rankingsOf(roster: Roster, rankerId: string) {
  return db
    .select()
    .from(rankings)
    .where(and(eq(rankings.eventId, roster.eventId), eq(rankings.rankerId, rankerId)))
    .orderBy(rankings.rank);
}

beforeAll(async () => {
  useMemoryStorageForTests();
  db = await createTestDb();
  await db.insert(admins).values({ id: adminId, name: "Admin", email: "admin@example.com" });
});

describe("supplier ranking choices: email, then company (feedback item 1)", () => {
  let roster: Roster;

  beforeAll(async () => {
    roster = await makeEvent("AW choices");
  });

  it("matches an email first, then a company only one buyer has, then the name", async () => {
    const outcome = await expectOk(
      await upload(
        roster,
        "supplier_rankings",
        listSheet([
          {
            name: "10 Hotel",
            choices: ["DSMITH2@example.com", "David Smith <dsmith1@example.com>", "abc association", "Frank Schmoe", "LMN Association."],
          },
        ]),
      ),
    );
    expect(outcome.report.unknownNames).toEqual([]);
    expect(outcome.state).toBe("ready");
    const { summary } = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    expect(summary.rankingsWritten).toBe(5);
    const rows = await rankingsOf(roster, roster.ids["10 Hotel"]);
    expect(rows.map((row) => row.targetId)).toEqual([
      roster.ids["dsmith2@example.com"],
      roster.ids["dsmith1@example.com"],
      roster.ids["jdoe@example.com"],
      roster.ids["fschmoe@example.com"],
      roster.ids["cbrown@example.com"],
    ]);
    // A company match is recomputed every time, never saved as an alias that could go stale.
    expect(await db.select().from(nameAliases).where(eq(nameAliases.eventId, roster.eventId))).toEqual([]);
  });

  it("sends a shared company, a shared name, or an unknown email to mapping with every match listed", async () => {
    const outcome = await expectOk(
      await upload(
        roster,
        "supplier_rankings",
        listSheet([
          { name: "20 Hotel", choices: ["GHI Association", "David Smith", "nobody@example.com"] },
          { name: "30 Hotel", choices: ["GHI Association"] },
        ]),
      ),
    );
    expect(outcome.state).toBe("needs_mapping");
    const byRaw = new Map(outcome.report.unknownNames.map((name) => [name.raw, name]));
    const davids = [roster.ids["dsmith1@example.com"], roster.ids["dsmith2@example.com"]].sort();
    expect(byRaw.get("GHI Association")).toMatchObject({ ambiguous: true, role: "target", rows: [2, 3] });
    expect(byRaw.get("GHI Association")!.suggestions.map((s) => s.entityId).sort()).toEqual(davids);
    expect(byRaw.get("David Smith")).toMatchObject({ ambiguous: true });
    expect(byRaw.get("David Smith")!.suggestions.map((s) => s.entityId).sort()).toEqual(davids);
    expect(byRaw.get("nobody@example.com")?.ambiguous).toBeUndefined();
    await deleteImportRecord(db, { importId: outcome.importId, adminId });
  });

  it("a mapping saved for a shared company resolves with a warning on every file, and only this event's mapping counts", async () => {
    const david1 = roster.ids["dsmith1@example.com"];
    const pending = await expectOk(
      await upload(roster, "supplier_rankings", listSheet([{ name: "20 Hotel", choices: ["GHI Association"] }, { name: "30 Hotel", choices: ["GHI Association"] }])),
    );
    await expectOk(await saveAliases(db, { eventId: roster.eventId, adminId, aliases: [{ raw: "GHI Association", entityType: "buyer", entityId: david1 }] }));
    const detail = await getImport(pending.importId, db);
    expect(detail?.state).toBe("ready");
    expect(detail?.report?.warnings).toContainEqual({
      row: null,
      message:
        'Rows 2, 3: "GHI Association" matches 2 participants. A saved mapping sends it to David Smith (GHI Association, Meeting Planner, dsmith1@example.com). If a row means someone else, put their email in the file instead.',
    });
    await deleteImportRecord(db, { importId: pending.importId, adminId });

    // A company is never saved as a cross-year alias to a person, and without this event's alias it needs mapping again.
    const globals = await db.select().from(nameAliases).where(and(isNull(nameAliases.eventId), eq(nameAliases.rawText, "GHI Association")));
    expect(globals).toEqual([]);
    await db.delete(nameAliases).where(and(eq(nameAliases.eventId, roster.eventId), eq(nameAliases.rawText, "GHI Association")));
    const again = await expectOk(await upload(roster, "supplier_rankings", listSheet([{ name: "20 Hotel", choices: ["GHI Association"] }])));
    expect(again.state).toBe("needs_mapping");
    expect(again.report.unknownNames[0]).toMatchObject({ raw: "GHI Association", ambiguous: true });
    await deleteImportRecord(db, { importId: again.importId, adminId });
  });

  it("a shared-text warning for one row carries that row and no row prefix of its own", async () => {
    const david1 = roster.ids["dsmith1@example.com"];
    const pending = await expectOk(
      await upload(roster, "supplier_rankings", listSheet([{ name: "20 Hotel", choices: ["GHI Association"] }])),
    );
    await expectOk(await saveAliases(db, { eventId: roster.eventId, adminId, aliases: [{ raw: "GHI Association", entityType: "buyer", entityId: david1 }] }));
    const detail = await getImport(pending.importId, db);
    const warning = detail?.report?.warnings.find((w) => w.message.includes("GHI Association"));
    expect(warning?.row).toBe(2);
    expect(warning?.message.startsWith('"GHI Association" matches 2 participants.')).toBe(true);
    await deleteImportRecord(db, { importId: pending.importId, adminId });
    await db.delete(nameAliases).where(and(eq(nameAliases.eventId, roster.eventId), eq(nameAliases.rawText, "GHI Association")));
  });
});

describe("mapping an email text or a company text (review findings)", () => {
  let roster: Roster;

  beforeAll(async () => {
    roster = await makeEvent("AW mapping");
  });

  it("an email that matches no roster email resolves through this event's alias and the file becomes ready", async () => {
    const raw = "Jane Doe <jane@oldcompany.com>";
    const pending = await expectOk(await upload(roster, "supplier_rankings", listSheet([{ name: "10 Hotel", choices: [raw] }])));
    expect(pending.state).toBe("needs_mapping");
    const saved = await expectOk(
      await saveAliases(db, { eventId: roster.eventId, adminId, aliases: [{ raw, entityType: "buyer", entityId: roster.ids["jdoe@example.com"] }] }),
    );
    expect(saved.imports).toContainEqual({ importId: pending.importId, kind: "supplier_rankings", state: "ready" });
    const detail = await getImport(pending.importId, db);
    expect(detail?.state).toBe("ready");
    expect(detail?.report?.unknownNames).toEqual([]);
    // An email text is not a name: no cross-year copy.
    const globals = await db.select().from(nameAliases).where(and(isNull(nameAliases.eventId), eq(nameAliases.rawText, raw)));
    expect(globals).toEqual([]);
    await deleteImportRecord(db, { importId: pending.importId, adminId });
  });

  it("an email that matches one roster email still wins over an alias for the same text", async () => {
    const raw = "dsmith2@example.com";
    await db.insert(nameAliases).values({ eventId: roster.eventId, rawText: raw, entityType: "buyer", entityId: roster.ids["dsmith1@example.com"], source: "manual" });
    const outcome = await expectOk(await upload(roster, "supplier_rankings", listSheet([{ name: "20 Hotel", choices: [raw] }])));
    expect(outcome.state).toBe("ready");
    const { summary } = await expectOk(await applyImport(db, { importId: outcome.importId, adminId }));
    expect(summary.rankingsWritten).toBe(1);
    expect((await rankingsOf(roster, roster.ids["20 Hotel"]))[0].targetId).toBe(roster.ids["dsmith2@example.com"]);
  });

  it("a plain unknown name still gets a cross-year alias, a company does not", async () => {
    await expectOk(
      await saveAliases(db, { eventId: roster.eventId, adminId, aliases: [{ raw: "Janie D.", entityType: "buyer", entityId: roster.ids["jdoe@example.com"] }] }),
    );
    await expectOk(
      await saveAliases(db, { eventId: roster.eventId, adminId, aliases: [{ raw: "GHI Association", entityType: "buyer", entityId: roster.ids["dsmith1@example.com"] }] }),
    );
    const globalFor = (raw: string) =>
      db.select().from(nameAliases).where(and(isNull(nameAliases.eventId), eq(nameAliases.rawText, raw)));
    expect(await globalFor("Janie D.")).toMatchObject([{ entityType: "buyer", canonicalName: "Jane Doe", source: "manual" }]);
    expect(await globalFor("GHI Association")).toEqual([]);
    // The event alias is kept for both.
    const eventAliases = await db.select().from(nameAliases).where(eq(nameAliases.eventId, roster.eventId));
    expect(eventAliases.map((alias) => alias.rawText)).toEqual(expect.arrayContaining(["Janie D.", "GHI Association"]));
  });
});

describe("ranking files replace per ranker (feedback item 2)", () => {
  let roster: Roster;
  let hotels: { importId: string };

  beforeAll(async () => {
    roster = await makeEvent("AW per ranker");
    hotels = await uploadAndApply(
      roster,
      "buyer_hotel_rankings",
      listSheet([
        { name: "Jane Doe", email: "jdoe@example.com", choices: ["20 Hotel", "30 Hotel", "10 Hotel"] },
        { name: "Frank Schmoe", email: "fschmoe@example.com", choices: ["10 Hotel", "20 Hotel"] },
        { name: "Chris Brown", email: "cbrown@example.com", choices: ["30 Hotel"] },
      ]),
    );
  });

  it("a one-row file changes only that person's rankings (Jane Doe's hotel update)", async () => {
    const jane = roster.ids["jdoe@example.com"];
    const update = await expectOk(
      await upload(roster, "buyer_hotel_rankings", listSheet([{ name: "Jane Doe", email: "jdoe@example.com", choices: ["10 Hotel", "20 Hotel"] }])),
    );
    expect(update.report.rankersInFile).toEqual([jane]);
    expect(await countRankingsToReplace(roster.eventId, "buyer_hotel_rankings", update.report.rankersInFile, db)).toBe(3);

    const { summary } = await expectOk(await applyImport(db, { importId: update.importId, adminId }));
    expect(summary).toMatchObject({ rankers: 1, rankingsDeleted: 3, rankingsWritten: 2 });
    expect((await rankingsOf(roster, jane)).map((r) => [r.targetId, r.rank])).toEqual([
      [roster.ids["10 Hotel"], 1],
      [roster.ids["20 Hotel"], 2],
    ]);
    expect(await rankingsOf(roster, roster.ids["fschmoe@example.com"])).toHaveLength(2);
    expect(await rankingsOf(roster, roster.ids["cbrown@example.com"])).toHaveLength(1);

    // Deleting the first file now removes only what it still holds: Frank's and Chris's rankings.
    const deleted = await expectOk(await deleteImportRecord(db, { importId: hotels.importId, adminId }));
    expect(deleted.rankingsDeleted).toBe(3);
    expect(await rankingsOf(roster, jane)).toHaveLength(2);
  });

  it("a row with no choices clears that ranker's rankings of the file's kind, with a warning first", async () => {
    const jane = roster.ids["jdoe@example.com"];
    await uploadAndApply(roster, "buyer_biztech_rankings", listSheet([{ name: "Jane Doe", email: "jdoe@example.com", choices: ["Biz One"] }]));
    const clear = await expectOk(await upload(roster, "buyer_hotel_rankings", listSheet([{ name: "Jane Doe", email: "jdoe@example.com", choices: [] }])));
    expect(clear.state).toBe("ready");
    expect(clear.report.warnings).toContainEqual({
      row: 2,
      message: "Jane Doe (ABC Association) has no choices in this file; their hotel rankings will be cleared.",
    });
    const { summary } = await expectOk(await applyImport(db, { importId: clear.importId, adminId }));
    expect(summary).toMatchObject({ rankers: 1, rankingsDeleted: 2, rankingsWritten: 0 });
    // Her biztech ranking is another kind and stays.
    expect((await rankingsOf(roster, jane)).map((r) => r.targetId)).toEqual([roster.ids["Biz One"]]);
  });

  it("biztech opt-in changes only for participants in the file", async () => {
    const chris = roster.ids["cbrown@example.com"];
    const frank = roster.ids["fschmoe@example.com"];
    const { summary } = await uploadAndApply(
      roster,
      "buyer_biztech_rankings",
      listSheet([
        { name: "Frank Schmoe", email: "fschmoe@example.com", choices: ["Biz Two"] },
        { name: "David Smith", email: "dsmith1@example.com", choices: [] },
      ]),
    );
    expect(summary).toMatchObject({ rankers: 2, optedIn: 1, optedOut: 1 });
    const flags = new Map(
      (await db.select().from(participants).where(eq(participants.eventId, roster.eventId))).map((p) => [p.id, p.biztechOptIn]),
    );
    expect(flags.get(frank)).toBe(true);
    expect(flags.get(roster.ids["dsmith1@example.com"])).toBe(false);
    // Not in the file: Chris stays opted in, and Jane keeps her ranking from the earlier biztech file.
    expect(flags.get(chris)).toBe(true);
    expect(await rankingsOf(roster, roster.ids["jdoe@example.com"])).toHaveLength(1);
  });

  it("leaves rankings loaded without an import alone unless the file ranks the same pair", async () => {
    const chris = roster.ids["cbrown@example.com"];
    await db.insert(rankings).values([
      { eventId: roster.eventId, rankerType: "buyer", rankerId: chris, targetType: "supplier", targetId: roster.ids["10 Hotel"], rank: 5 },
      { eventId: roster.eventId, rankerType: "buyer", rankerId: chris, targetType: "supplier", targetId: roster.ids["20 Hotel"], rank: 6 },
    ]);
    const { summary } = await uploadAndApply(
      roster,
      "buyer_hotel_rankings",
      listSheet([{ name: "Chris Brown", email: "cbrown@example.com", choices: ["10 Hotel"] }]),
    );
    // Chris's file-made ranking of 30 Hotel was deleted with the first file above, so nothing from a file is replaced.
    expect(summary).toMatchObject({ rankingsDeleted: 0, rankingsWritten: 1 });
    const rows = await rankingsOf(roster, chris);
    expect(rows.map((r) => [r.targetId, r.rank, r.importId === null])).toEqual([
      [roster.ids["10 Hotel"], 1, false],
      [roster.ids["20 Hotel"], 6, true],
    ]);
  });
});

describe("ranked by nobody counts only the file's supplier type (feedback item 3)", () => {
  it("lists hotels for the hotel file and business suppliers for the biztech file", async () => {
    const roster = await makeEvent("AW types");
    const hotel = await expectOk(
      await upload(roster, "buyer_hotel_rankings", listSheet([{ name: "Jane Doe", email: "jdoe@example.com", choices: ["10 Hotel"] }])),
    );
    expect(hotel.report.rankedByNobody.map((e) => e.name).sort()).toEqual(["20 Hotel", "30 Hotel"]);
    expect(hotel.report.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        "This file has rankings for 1 of 5 active participants. Everyone else keeps their current rankings.",
        "Nobody in this file chose 2 of 3 active hotel suppliers. Rankings from earlier files still count.",
      ]),
    );
    const biztech = await expectOk(
      await upload(roster, "buyer_biztech_rankings", listSheet([{ name: "Jane Doe", email: "jdoe@example.com", choices: ["Biz One"] }])),
    );
    expect(biztech.report.rankedByNobody.map((e) => e.name)).toEqual(["Biz Two"]);
    expect(biztech.report.warnings.map((w) => w.message)).toContain(
      "Nobody in this file chose 1 of 2 active business suppliers. Rankings from earlier files still count.",
    );
  });
});

describe("ignoring a file (feedback item 4)", () => {
  let roster: Roster;
  let applied: string;
  let pending: string;

  beforeAll(async () => {
    roster = await makeEvent("AW ignore");
    applied = (
      await uploadAndApply(roster, "buyer_biztech_rankings", listSheet([{ name: "Jane Doe", email: "jdoe@example.com", choices: ["Biz One"] }]))
    ).importId;
    pending = (
      await expectOk(
        await upload(roster, "buyer_biztech_rankings", listSheet([{ name: "Jane Doe", email: "jdoe@example.com", choices: ["Biz Two"] }])),
      )
    ).importId;
  });

  it("keeps the file in history but skips it, so the applied file before it counts again", async () => {
    expect((await getImportStatusByKind(roster.eventId, db)).buyer_biztech_rankings).toMatchObject({ id: pending, state: "ready" });
    const waiting = "The buyer biztech rankings file is checked but not applied. Apply it.";
    expect((await matchingReadiness(db, roster.eventId)).reasons).toContain(waiting);

    await expectOk(await ignoreImport(db, { importId: pending, adminId }));
    expect(await getImport(pending, db)).toMatchObject({ status: "ignored", state: "ignored" });
    expect((await getImportStatusByKind(roster.eventId, db)).buyer_biztech_rankings).toMatchObject({ id: applied, state: "applied" });
    expect((await matchingReadiness(db, roster.eventId)).reasons).not.toContain(waiting);

    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "import.ignore"), eq(auditEvents.entityId, pending)));
    expect(audit).toMatchObject([{ eventId: roster.eventId, adminId, before: { status: "validated" }, after: { status: "ignored" } }]);
  });

  it("is never applied or re-validated while ignored", async () => {
    expect(await applyImport(db, { importId: pending, adminId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await ignoreImport(db, { importId: pending, adminId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    // A mapping re-validates pending imports; the ignored one is left alone.
    const saved = await expectOk(
      await saveAliases(db, { eventId: roster.eventId, adminId, aliases: [{ raw: "Biz 2", entityType: "supplier", entityId: roster.ids["Biz Two"] }] }),
    );
    expect(saved.imports.map((entry) => entry.importId)).not.toContain(pending);
    expect((await getImport(pending, db))?.status).toBe("ignored");
  });

  it("stop ignoring checks the file again and writes an audit row", async () => {
    const result = await expectOk(await stopIgnoringImport(db, { importId: pending, adminId }));
    expect(result.state).toBe("ready");
    expect(await getImport(pending, db)).toMatchObject({ status: "validated", state: "ready" });
    expect(await stopIgnoringImport(db, { importId: pending, adminId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "import.unignore"), eq(auditEvents.entityId, pending)));
    expect(audit).toMatchObject([{ before: { status: "ignored" }, after: { status: "validated", state: "ready" } }]);
  });

  it("refuses an applied file, a locked event, and a lock that lands after the check", async () => {
    expect(await ignoreImport(db, { importId: applied, adminId })).toMatchObject({
      ok: false,
      error: { code: "conflict", message: expect.stringContaining("applied") },
    });

    await db.update(events).set({ status: "locked" }).where(eq(events.id, roster.eventId));
    expect(await ignoreImport(db, { importId: pending, adminId })).toMatchObject({ ok: false, error: { code: "locked" } });
    await db.update(events).set({ status: "imported" }).where(eq(events.id, roster.eventId));

    const lock = () => db.update(events).set({ status: "locked" }).where(eq(events.id, roster.eventId));
    const raced = await ignoreImport(raceBeforeTransaction(db, lock), { importId: pending, adminId });
    expect(raced).toEqual({ ok: false, error: { code: "conflict", message: EVENT_CHANGED_MESSAGE } });
    expect((await getImport(pending, db))?.status).toBe("validated");
    await db.update(events).set({ status: "imported" }).where(eq(events.id, roster.eventId));
  });

  it("loses to an apply that got there first", async () => {
    const apply = () => applyImport(db, { importId: pending, adminId });
    const raced = await ignoreImport(raceBeforeTransaction(db, apply), { importId: pending, adminId });
    expect(raced).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await db.select().from(imports).where(eq(imports.id, pending)))[0].status).toBe("applied");
  });
});
