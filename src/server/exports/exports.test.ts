import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { auditEvents, matchRuns, participants } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { lockSchedule } from "@/server/schedule/lock";
import { getScheduleView } from "@/server/schedule/views";
import { verifyToken } from "@/server/tokens/tokens";
import { accessCsv } from "./access";
import { recordExport } from "./actions";
import { BOM } from "./common";
import { isSameOrigin } from "./http";
import { masterScheduleCsv } from "./master";
import { loadParticipantView } from "./participant";
import { exportAvailability } from "./queries";

let db: Db;
let seeded: Seeded;

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
});

function tokenFromLink(link: string): string {
  return link.slice(link.lastIndexOf("/") + 1);
}

describe("exports against a real run", () => {
  it("offers nothing before a run is active", async () => {
    const availability = await exportAvailability(seeded.eventId, db);
    expect(availability?.activeRun).toBeNull();
    expect(Object.values(availability!.exports).every((e) => !e.available && e.reason)).toBe(true);
    expect(await exportAvailability("00000000-0000-4000-8000-000000000000", db)).toBeNull();
  });

  it("offers schedule exports once a run is active, and the access list only after lock", async () => {
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    expect(run.ok).toBe(true);
    const availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.master).toMatchObject({ available: true, reason: null, last: null, scheduleChanged: false });
    expect(availability.exports.schedules.filename).toBe("AW_2026_Schedules.zip");
    expect(availability.exports.access_list.available).toBe(false);
    expect(availability.exports.access_list.reason).toMatch(/Lock the schedule/);
  });

  it("builds a master CSV with one row per appointment", async () => {
    const view = (await getScheduleView(seeded.eventId, db))!;
    const lines = masterScheduleCsv(view).slice(BOM.length).trimEnd().split("\n");
    expect(lines).toHaveLength(view.appointments.length + 1);
  });

  it("records an export and flags a schedule change after the run version moves", async () => {
    const view = (await getScheduleView(seeded.eventId, db))!;
    await recordExport(
      { eventId: seeded.eventId, adminId: seeded.adminId, kind: "master", runId: view.run!.id, runVersion: view.run!.version },
      db,
    );
    let availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.master.last).toMatchObject({ byName: "Test Admin", runVersion: view.run!.version });
    expect(availability.exports.master.scheduleChanged).toBe(false);
    expect(availability.exports.report.last).toBeNull();

    await db.update(matchRuns).set({ version: view.run!.version + 1 }).where(eq(matchRuns.id, view.run!.id));
    availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.master.scheduleChanged).toBe(true);
  });

  it("access CSV reuses links, audits, and the new links open schedules without ranks", async () => {
    const locked = await lockSchedule(db, { eventId: seeded.eventId, adminId: seeded.adminId });
    expect(locked.ok).toBe(true);
    const before = await db.select().from(auditEvents).where(eq(auditEvents.action, "export.access_list"));

    const result = await accessCsv(seeded.eventId, seeded.adminId, db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.data.csv.slice(BOM.length).trimEnd().split("\n");
    expect(lines[0]).toBe("Name,Email,Contact type,Link");
    // 12 buyers + 6 supplier admins + 3 attendees
    expect(lines).toHaveLength(22);
    expect(result.data.count).toBe(21);
    const after = await db.select().from(auditEvents).where(eq(auditEvents.action, "export.access_list"));
    expect(after).toHaveLength(before.length + 1);

    const buyerLine = lines.find((l) => l.includes(",Buyer,"))!;
    const buyerToken = tokenFromLink(buyerLine.split(",").at(-1)!);
    const buyerView = await loadParticipantView(buyerToken, db);
    expect(buyerView?.contactType).toBe("buyer");
    expect(buyerView?.schedule.slots).toHaveLength(9);
    const json = JSON.stringify(buyerView);
    expect(json).not.toMatch(/Rank|strength/);

    const supplierLine = lines.find((l) => l.includes(",Supplier admin,"))!;
    const supplierView = await loadParticipantView(tokenFromLink(supplierLine.split(",").at(-1)!), db);
    expect(supplierView?.schedule.person.type).toBe("supplier");
    expect(supplierView?.schedule.person.desk).not.toBeNull();

    // A second access list hands out the same links (D31, D59).
    const again = await accessCsv(seeded.eventId, seeded.adminId, db);
    expect(again.ok).toBe(true);
    expect(again.ok && again.data.csv).toBe(result.data.csv);
    expect(await loadParticipantView(buyerToken, db)).not.toBeNull();
  });

  it("refuses unknown tokens and withdrawn people with the same null", async () => {
    expect(await loadParticipantView("not-a-token", db)).toBeNull();
    expect(await loadParticipantView("", db)).toBeNull();

    const result = await accessCsv(seeded.eventId, seeded.adminId, db);
    if (!result.ok) throw new Error(result.error.message);
    const line = result.data.csv.split("\n").find((l) => l.includes(",Buyer,"))!;
    const token = tokenFromLink(line.split(",").at(-1)!);
    const verified = await verifyToken(db, token);
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, verified!.entityId));
    expect(await loadParticipantView(token, db)).toBeNull();
  });
});

describe("isSameOrigin", () => {
  const post = (headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/exports/x/access", { method: "POST", headers });

  it("accepts same-origin and origin-less requests and refuses others", () => {
    expect(isSameOrigin(post({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(isSameOrigin(post({}))).toBe(true);
    expect(isSameOrigin(post({ origin: "https://evil.example", host: "localhost:3000" }))).toBe(false);
  });
});
