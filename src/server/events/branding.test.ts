import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { admins, events, pendingFileDeletions } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { failNextDeletesForTests, getFile, useMemoryStorageForTests } from "@/lib/storage";
import { listAudit } from "@/server/audit/audit";
import { describeAudit } from "@/server/audit/describe";
import { drainFileDeletions } from "@/server/files/cleanup";
import { loadPersonSchedule } from "@/server/schedule/snapshot";
import { seedEvent } from "@/server/matching/test-seed";
import { loadCurrentLogo, logoUrl, saveBranding } from "./branding";
import { createEvent, deleteEvent } from "./events";
import { getEvent } from "./queries";

const ACTOR = "admin-test";
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  useMemoryStorageForTests();
  await db.insert(admins).values({ id: ACTOR, name: "Tester", email: "tester@example.com" });
});

async function makeEvent() {
  const result = await createEvent(db, { name: "Branding test", eventDate: "2026-11-10", timezone: "America/Los_Angeles" }, ACTOR);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.id;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
const colors = { primaryColor: "#1D4ED8", accentColor: "#f59e0b" };

describe("saveBranding", () => {
  it("saves lowercase colors and a logo, and audits the change", async () => {
    const id = await makeEvent();
    const result = await saveBranding(db, id, { colors, logo: PNG }, ACTOR);
    expect(result.ok).toBe(true);

    const branding = (await getEvent(id, db))!.branding!;
    expect(branding).toMatchObject({ primaryColor: "#1d4ed8", accentColor: "#f59e0b", logoType: "image/png" });
    expect((await getFile(branding.logoKey!))?.contentType).toBe("image/png");
    const url = logoUrl(id, branding)!;
    expect(url).toMatch(new RegExp(`^/api/branding/${id}/logo-[0-9a-f-]{36}\\.png$`));
    const file = url.slice(url.lastIndexOf("/") + 1);
    expect((await loadCurrentLogo(id, file, db))?.body.equals(PNG)).toBe(true);
    // Only the current logo of that event is served.
    expect(await loadCurrentLogo(id, "logo-00000000-0000-4000-8000-000000000000.png", db)).toBeNull();
    expect(await loadCurrentLogo(await makeEvent(), file, db)).toBeNull();
    expect(await loadCurrentLogo(id, "../../imports/x.csv", db)).toBeNull();

    const audit = (await listAudit({ eventId: id }, db)).rows.find((r) => r.action === "event.branding")!;
    expect(describeAudit(audit, new Map())).toBe("Changed the schedule page branding: colors and logo");
  });

  it("keeps the logo when only colors change, and clears a color sent empty", async () => {
    const id = await makeEvent();
    await saveBranding(db, id, { colors, logo: PNG }, ACTOR);
    const first = (await getEvent(id, db))!.branding!;

    await saveBranding(db, id, { colors: { primaryColor: "#000000", accentColor: "" } }, ACTOR);
    const second = (await getEvent(id, db))!.branding!;
    expect(second).toMatchObject({ primaryColor: "#000000", accentColor: null, logoKey: first.logoKey });
  });

  it("deletes the old logo file when it is replaced or removed", async () => {
    const id = await makeEvent();
    await saveBranding(db, id, { colors, logo: PNG }, ACTOR);
    const png = (await getEvent(id, db))!.branding!;

    await saveBranding(db, id, { colors, logo: SVG }, ACTOR);
    const svg = (await getEvent(id, db))!.branding!;
    expect(svg.logoType).toBe("image/svg+xml");
    expect(svg.logoKey).not.toBe(png.logoKey);
    expect(await getFile(png.logoKey!)).toBeNull();

    await saveBranding(db, id, { colors, removeLogo: true }, ACTOR);
    expect((await getEvent(id, db))!.branding).toMatchObject({ logoKey: null, logoType: null });
    expect(await getFile(svg.logoKey!)).toBeNull();
    expect(logoUrl(id, (await getEvent(id, db))!.branding)).toBeNull();
    expect(await loadCurrentLogo(id, svg.logoKey!.split("/").at(-1)!, db)).toBeNull();
  });

  it("queues the replaced logo with the row change, so a failed delete is retried", async () => {
    const id = await makeEvent();
    await saveBranding(db, id, { colors, logo: PNG }, ACTOR);
    const old = (await getEvent(id, db))!.branding!.logoKey!;

    failNextDeletesForTests();
    expect((await saveBranding(db, id, { colors, logo: SVG }, ACTOR)).ok).toBe(true);
    expect(await getFile(old)).not.toBeNull();
    const [queued] = await db.select().from(pendingFileDeletions).where(eq(pendingFileDeletions.storageKey, old));
    expect(queued).toMatchObject({ attempts: 1 });

    await drainFileDeletions(db, { now: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    expect(await getFile(old)).toBeNull();
    expect(await db.select().from(pendingFileDeletions).where(eq(pendingFileDeletions.storageKey, old))).toHaveLength(0);
  });

  it("rejects bad colors, other file types, and big files without changing anything", async () => {
    const id = await makeEvent();
    const badColor = await saveBranding(db, id, { colors: { primaryColor: "blue", accentColor: "" } }, ACTOR);
    expect(!badColor.ok && badColor.error.fieldErrors?.primaryColor).toBeDefined();

    const html = await saveBranding(db, id, { colors, logo: Buffer.from("<html></html>") }, ACTOR);
    expect(!html.ok && html.error.fieldErrors?.logo).toBeDefined();

    const big = await saveBranding(db, id, { colors, logo: Buffer.concat([PNG, Buffer.alloc(300 * 1024)]) }, ACTOR);
    expect(!big.ok && big.error.fieldErrors?.logo).toBeDefined();

    expect((await getEvent(id, db))!.branding).toBeNull();
  });

  it("works on a locked event but not an archived one", async () => {
    const id = await makeEvent();
    await db.update(events).set({ status: "locked" }).where(eq(events.id, id));
    expect((await saveBranding(db, id, { colors }, ACTOR)).ok).toBe(true);

    await db.update(events).set({ status: "archived" }).where(eq(events.id, id));
    const archived = await saveBranding(db, id, { colors: { primaryColor: "", accentColor: "" } }, ACTOR);
    expect(!archived.ok && archived.error.code).toBe("locked");
    expect((await getEvent(id, db))!.branding?.primaryColor).toBe("#1d4ed8");
  });
});

describe("branding on other paths", () => {
  it("deleteEvent removes the logo file", async () => {
    const id = await makeEvent();
    await saveBranding(db, id, { colors, logo: PNG }, ACTOR);
    const key = (await getEvent(id, db))!.branding!.logoKey!;
    const result = await deleteEvent(db, id, ACTOR);
    expect(result).toEqual({ ok: true, data: { id } });
    expect(await getFile(key)).toBeNull();
    expect(await db.select().from(pendingFileDeletions).where(eq(pendingFileDeletions.storageKey, key))).toHaveLength(0);
  });

  it("reaches the participant schedule without any ranking fields", async () => {
    const seeded = await seedEvent(db);
    await saveBranding(db, seeded.eventId, { colors, logo: PNG }, seeded.adminId);
    const schedule = await loadPersonSchedule(db, seeded.eventId, { type: "buyer", id: seeded.buyers[0].id });
    expect(schedule?.event.branding).toMatchObject({ primaryColor: "#1d4ed8", accentColor: "#f59e0b" });
  });
});
