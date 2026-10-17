import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens, auditEvents, participants, suppliers } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { compareNames } from "@/lib/names";
import { startRun } from "@/server/matching/runs";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { withdrawParticipant, withdrawSupplier } from "@/server/roster/roster";
import { issueAccessList } from "@/server/tokens/queries";
import { revokeToken } from "@/server/tokens/tokens";
import { accessCsv } from "./access";
import { recordExport } from "./actions";
import { BOM } from "./common";
import { exportFilename } from "./kinds";
import { LINK_REVOKED, NO_LINK, loadLinkRows, personLinkKey } from "./links";
import { exportAvailability } from "./queries";
import { PARTICIPANT_FULL_COLUMNS, SUPPLIER_FULL_COLUMNS, participantsFullCsv, suppliersFullCsv } from "./roster";

let db: Db;
let seeded: Seeded;

/** Minimal RFC 4180 reader: quoted fields may hold commas, quotes (doubled), and line breaks. */
function parseCsv(csv: string): string[][] {
  const text = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function records(csv: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function participantRows() {
  const result = await participantsFullCsv(seeded.eventId, db);
  if (!result.ok) throw new Error(result.error.message);
  return { ...result.data, rows: records(result.data.csv) };
}

async function supplierRows() {
  const result = await suppliersFullCsv(seeded.eventId, db);
  if (!result.ok) throw new Error(result.error.message);
  return { ...result.data, rows: records(result.data.csv) };
}

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
});

describe("the full lists before any schedule exists", () => {
  it("are available without an active run and are named for the year", async () => {
    const availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.activeRun).toBeNull();
    for (const kind of ["participants_full", "suppliers_full"] as const) {
      expect(availability.exports[kind]).toMatchObject({ available: true, reason: null, scheduleChanged: false });
    }
    expect(exportFilename("participants_full", "2026")).toBe("AW_2026_Participants_Full.csv");
    expect(exportFilename("suppliers_full", "2026")).toBe("AW_2026_Suppliers_Full.csv");
  });

  it("list every participant with the stored fields, sorted, appointments blank", async () => {
    const { csv, count, rows } = await participantRows();
    expect(parseCsv(csv)[0]).toEqual(PARTICIPANT_FULL_COLUMNS);
    expect(count).toBe(12);
    expect(rows).toHaveLength(12);
    const names = rows.map((r) => `${r["Last name"]} ${r["First name"]}`);
    expect(names).toEqual([...names].sort(compareNames));
    expect(rows.find((r) => r.Email === "buyer0@example.com")).toMatchObject({
      "First name": "Buyer0",
      "Last name": "Person",
      Organization: "Org 0",
      Title: "Title 0",
      "Display name": "",
      "Biztech opt-in": "Yes",
      Status: "Active",
      "Withdrawn on": "",
      Appointments: "",
      Link: "No link",
      "Changed since last email": "",
    });
    expect(rows.find((r) => r.Email === "buyer11@example.com")?.["Biztech opt-in"]).toBe("No");
    // Timestamps are in the event's timezone, with a year.
    expect(rows[0].Created).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM)$/);
  });

  it("list every supplier with both contacts, and no link state for a missing contact", async () => {
    const { csv, count, rows } = await supplierRows();
    expect(parseCsv(csv)[0]).toEqual(SUPPLIER_FULL_COLUMNS);
    expect(count).toBe(6);
    const names = rows.map((r) => r.Name);
    expect(names).toEqual([...names].sort(compareNames));
    expect(rows.find((r) => r.Name === "Hyatt Regency Monterey")).toMatchObject({
      Type: "Hotel",
      Desk: "",
      "Desk set by hand": "No",
      "Admin contact name": "Hyatt Regency Monterey admin",
      "Attendee contact email": "attendee0@supplier.example.com",
      Status: "Active",
      Appointments: "",
      "Admin link": "No link",
      "Attendee link": "No link",
    });
    expect(rows.find((r) => r.Name === "Alpha Audio")).toMatchObject({
      Type: "Business",
      "Attendee contact name": "",
      "Attendee link": "",
    });
  });
});

describe("the full lists after withdrawals, edits, a run, and links", () => {
  let withdrawnBuyerId: string;
  let withdrawnSupplierId: string;

  beforeAll(async () => {
    withdrawnBuyerId = seeded.buyers[3].id;
    withdrawnSupplierId = seeded.suppliers[1].id;
    expect((await withdrawParticipant(db, { adminId: seeded.adminId, id: withdrawnBuyerId })).ok).toBe(true);
    expect((await withdrawSupplier(db, { adminId: seeded.adminId, id: withdrawnSupplierId })).ok).toBe(true);
    await db
      .update(participants)
      .set({ organization: "Edited by hand, Inc", displayName: "Bee Person" })
      .where(eq(participants.id, seeded.buyers[1].id));
    await db.update(suppliers).set({ deskNumber: 4, deskOverride: true }).where(eq(suppliers.id, seeded.suppliers[0].id));
    const run = await startRun(db, { eventId: seeded.eventId, adminId: seeded.adminId, keepExisting: false });
    expect(run.ok).toBe(true);
  });

  it("keep withdrawn people, with the date they were withdrawn", async () => {
    const { rows } = await participantRows();
    expect(rows).toHaveLength(12);
    const gone = rows.find((r) => r.Email === seeded.buyers[3].email)!;
    expect(gone.Status).toBe("Withdrawn");
    expect(gone["Withdrawn on"]).toMatch(/\d{4}/);
    expect(gone.Appointments).toBe("0");
    expect(rows.filter((r) => r.Status === "Withdrawn")).toHaveLength(1);

    const suppliersOut = (await supplierRows()).rows;
    expect(suppliersOut).toHaveLength(6);
    const goneSupplier = suppliersOut.find((r) => r.Name === seeded.suppliers[1].name)!;
    expect(goneSupplier).toMatchObject({ Status: "Withdrawn", Appointments: "0" });
    expect(goneSupplier["Withdrawn on"]).toMatch(/\d{4}/);
  });

  it("show current values, manual edits included", async () => {
    const { rows } = await participantRows();
    const edited = rows.find((r) => r.Email === seeded.buyers[1].email)!;
    expect(edited).toMatchObject({ Organization: "Edited by hand, Inc", "Display name": "Bee Person" });
    const hyatt = (await supplierRows()).rows.find((r) => r.Name === seeded.suppliers[0].name)!;
    expect(hyatt).toMatchObject({ Desk: "4", "Desk set by hand": "Yes" });
  });

  it("count appointments on the active run", async () => {
    const { rows } = await participantRows();
    const counts = rows.filter((r) => r.Status === "Active").map((r) => Number(r.Appointments));
    expect(counts.every((n) => n > 0)).toBe(true);
    const supplierCounts = (await supplierRows()).rows.filter((r) => r.Status === "Active").map((r) => Number(r.Appointments));
    expect(supplierCounts.every((n) => n > 0)).toBe(true);
  });

  it("report link states, then never hold a token, hash, or link", async () => {
    const issued = await accessCsv(seeded.eventId, seeded.adminId, db);
    if (!issued.ok) throw new Error(issued.error.message);
    const [buyerToken] = await db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.entityId, seeded.buyers[0].id));
    expect((await revokeToken(db, buyerToken.id, seeded.adminId)).ok).toBe(true);
    await db
      .update(accessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accessTokens.entityId, seeded.buyers[2].id));

    const { csv, rows } = await participantRows();
    expect(rows.find((r) => r.Email === seeded.buyers[0].email)?.Link).toBe("Revoked");
    expect(rows.find((r) => r.Email === seeded.buyers[2].email)?.Link).toBe("Expired");
    expect(rows.find((r) => r.Email === seeded.buyers[4].email)?.Link).toBe("Link active");
    // The access list skips withdrawn people, so the withdrawn buyer never got a link.
    expect(rows.find((r) => r.Email === seeded.buyers[3].email)?.Link).toBe("No link");

    const supplierOut = await supplierRows();
    const monterey = supplierOut.rows.find((r) => r.Name === "Monterey Plaza Hotel")!;
    expect(monterey).toMatchObject({ "Admin link": "Link active", "Attendee link": "Link active" });

    const hashes = (await db.select().from(accessTokens)).flatMap((t) => [t.tokenHash, t.tokenCiphertext ?? ""]);
    for (const secret of hashes.filter(Boolean)) {
      expect(csv).not.toContain(secret);
      expect(supplierOut.csv).not.toContain(secret);
    }
    expect(csv + supplierOut.csv).not.toMatch(/\/s\//);
  });

  it("are audited without a run and offered on any event status", async () => {
    await recordExport({ eventId: seeded.eventId, adminId: seeded.adminId, kind: "participants_full", details: { rows: 12 } }, db);
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, "export.participants_full"));
    expect(row).toMatchObject({ entityType: "event", entityId: seeded.eventId });
    const availability = (await exportAvailability(seeded.eventId, db))!;
    expect(availability.exports.participants_full.last?.byName).toBe("Test Admin");
    expect(availability.exports.participants_full.scheduleChanged).toBe(false);
  });
});

describe("schedule link rows read from the database", () => {
  let linkSeed: Seeded;

  beforeAll(async () => {
    linkSeed = await seedEvent(db);
  });

  it("say no link was generated before links exist, and write nothing", async () => {
    const links = await loadLinkRows(db, linkSeed.eventId);
    expect(links.get(personLinkKey("buyer", linkSeed.buyers[0].id))).toEqual([{ label: "Schedule link", value: NO_LINK }]);
    expect(await db.select().from(accessTokens).where(eq(accessTokens.eventId, linkSeed.eventId))).toHaveLength(0);
  });

  it("reuse the live link people already hold, one row per supplier contact", async () => {
    const list = await issueAccessList(db, linkSeed.eventId);
    if (!list.ok) throw new Error(list.error.message);
    const tokenCount = (await db.select().from(accessTokens).where(eq(accessTokens.eventId, linkSeed.eventId))).length;

    const links = await loadLinkRows(db, linkSeed.eventId);
    const buyer = linkSeed.buyers[0];
    const buyerLink = list.data.rows.find((r) => r.email === buyer.email)!.link?.url;
    expect(links.get(personLinkKey("buyer", buyer.id))).toEqual([{ label: "Schedule link", value: buyerLink }]);

    const hyatt = linkSeed.suppliers[0];
    const hyattRows = links.get(personLinkKey("supplier", hyatt.id))!;
    expect(hyattRows.map((r) => r.label)).toEqual([
      "Admin schedule link (Hyatt Regency Monterey admin)",
      "Attendee schedule link (Hyatt Regency Monterey attendee)",
    ]);
    expect(hyattRows[0].value).toBe(list.data.rows.find((r) => r.email === hyatt.adminContactEmail)!.link?.url);
    // A supplier with only an admin contact has one row.
    expect(links.get(personLinkKey("supplier", linkSeed.suppliers[1].id))).toHaveLength(1);

    // Reading changes nothing.
    expect(await db.select().from(accessTokens).where(eq(accessTokens.eventId, linkSeed.eventId))).toHaveLength(tokenCount);
  });

  it("say why a link is not usable", async () => {
    const [token] = await db.select().from(accessTokens).where(eq(accessTokens.entityId, linkSeed.buyers[0].id));
    await revokeToken(db, token.id, linkSeed.adminId);
    await db
      .update(accessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accessTokens.entityId, linkSeed.buyers[1].id));
    const links = await loadLinkRows(db, linkSeed.eventId);
    expect(links.get(personLinkKey("buyer", linkSeed.buyers[0].id))?.[0].value).toBe(LINK_REVOKED);
    expect(links.get(personLinkKey("buyer", linkSeed.buyers[1].id))?.[0].value).toBe("Link expired");
  });
});
