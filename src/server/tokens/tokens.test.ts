import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { env } from "@/lib/env";
import { decryptToken, generateToken, hashToken } from "@/lib/tokens";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { issueAccessList, listTokens } from "./queries";
import {
  issueTokensForEvent,
  linkFor,
  linksForContacts,
  regenerateToken,
  revokeToken,
  tokenExpiry,
  verifyToken,
  type IssuedToken,
} from "./tokens";

let db: Db;
let seeded: Seeded;
let issued: IssuedToken[];

beforeAll(async () => {
  db = await createTestDb();
  seeded = await seedEvent(db);
});

describe("token primitives (D14)", () => {
  it("generates 32 random bytes as base64url and hashes with the pepper", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token, "pepper-a")).not.toBe(hashToken(token, "pepper-b"));
    expect(linkFor(token)).toBe(`${env.APP_URL}/s/${token}`);
  });

  it("expires at the end of the day 60 days after the event, in the event timezone", () => {
    const before = new Date("2026-10-04T12:00:00Z");
    const expiry = tokenExpiry("2026-11-10", "America/Los_Angeles", before);
    // Jan 9, 2027 23:59:59.999 in Los Angeles (UTC-8).
    expect(expiry.toISOString()).toBe("2027-01-10T07:59:59.999Z");
    expect(tokenExpiry("2026-11-10", "UTC", before).toISOString()).toBe("2027-01-09T23:59:59.999Z");
  });

  it("gives a link issued after the event 60 days from now instead of expiring it at once", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    // A 2025 event: 60 days after it is long past, so now + 60 days wins.
    expect(tokenExpiry("2025-11-14", "America/Los_Angeles", now).toISOString()).toBe("2026-12-03T12:00:00.000Z");
    // The day the two meet, the event rule still decides when it is later.
    const late = new Date("2026-11-10T20:00:00Z");
    expect(tokenExpiry("2026-11-10", "America/Los_Angeles", late).toISOString()).toBe("2027-01-10T07:59:59.999Z");
  });
});

describe("issue and verify", () => {
  it("issues one token per contact with an email, and none twice", async () => {
    const result = await issueTokensForEvent(db, seeded.eventId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    issued = result.data;
    // 12 buyers + 6 supplier admins + 3 attendees
    expect(issued).toHaveLength(21);
    expect(issued.filter((t) => t.contactType === "buyer")).toHaveLength(12);
    expect(issued.filter((t) => t.contactType === "supplier_admin")).toHaveLength(6);
    expect(issued.filter((t) => t.contactType === "supplier_attendee")).toHaveLength(3);
    expect(issued.every((t) => t.email.includes("@") && t.name !== "")).toBe(true);

    const again = await issueTokensForEvent(db, seeded.eventId);
    expect(again.ok && again.data).toEqual([]);

    const stored = await db.select().from(accessTokens).where(eq(accessTokens.eventId, seeded.eventId));
    expect(stored).toHaveLength(21);
    expect(stored.map((s) => s.tokenHash)).toContain(hashToken(issued[0].token));
    expect(stored.some((s) => s.tokenHash === issued[0].token)).toBe(false);
  });

  it("verifies a live token and records the view", async () => {
    const first = issued[0];
    const verified = await verifyToken(db, first.token);
    expect(verified).toEqual({
      tokenId: first.tokenId,
      eventId: seeded.eventId,
      contactType: first.contactType,
      entityId: first.entityId,
    });
    const [row] = await db.select().from(accessTokens).where(eq(accessTokens.id, first.tokenId));
    expect(row.lastViewedAt).not.toBeNull();
    expect(await verifyToken(db, "not-a-token")).toBeNull();
    expect(await verifyToken(db, "")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = generateToken();
    await db.insert(accessTokens).values({
      eventId: seeded.eventId,
      contactType: "buyer",
      entityId: seeded.buyers[0].id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await verifyToken(db, token)).toBeNull();
  });

  it("rejects a token hashed under a different pepper", async () => {
    const token = generateToken();
    await db.insert(accessTokens).values({
      eventId: seeded.eventId,
      contactType: "buyer",
      entityId: seeded.buyers[1].id,
      tokenHash: hashToken(token, "some-other-pepper"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await verifyToken(db, token)).toBeNull();
  });

  it("revoke stops a token; regenerate replaces it for the same contact", async () => {
    const target = issued[1];
    const revoked = await revokeToken(db, target.tokenId);
    expect(revoked.ok).toBe(true);
    expect(await verifyToken(db, target.token)).toBeNull();
    expect((await revokeToken(db, target.tokenId)).ok).toBe(true);

    const other = issued[2];
    const regenerated = await regenerateToken(db, other.tokenId);
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    expect(regenerated.data.previousTokenId).toBe(other.tokenId);
    expect(regenerated.data.tokenId).not.toBe(other.tokenId);
    expect(await verifyToken(db, other.token)).toBeNull();
    const verified = await verifyToken(db, regenerated.data.token);
    expect(verified?.contactType).toBe(other.contactType);
    expect(verified?.entityId).toBe(other.entityId);

    expect((await revokeToken(db, "00000000-0000-0000-0000-000000000000")).ok).toBe(false);
  });

  it("listTokens shows status per contact and never the token", async () => {
    const list = await listTokens(seeded.eventId, db);
    expect(list.length).toBeGreaterThanOrEqual(21);
    const byStatus = (status: string) => list.filter((t) => t.status === status).length;
    expect(byStatus("revoked")).toBe(2);
    expect(byStatus("expired")).toBe(1);
    expect(list.every((t) => !("tokenHash" in t) && !("token" in t))).toBe(true);
    const supplierAdmin = list.find((t) => t.contactType === "supplier_admin");
    expect(supplierAdmin?.name).toMatch(/\(.* admin\)$/);
    expect(supplierAdmin?.email).toMatch(/@supplier\.example\.com$/);
  });

  it("stores the token encrypted beside the hash (D59)", async () => {
    const [row] = await db.select().from(accessTokens).where(eq(accessTokens.id, issued[0].tokenId));
    expect(row.tokenCiphertext).not.toBeNull();
    expect(row.tokenCiphertext).not.toContain(issued[0].token);
    expect(decryptToken(row.tokenCiphertext!)).toBe(issued[0].token);
  });

  it("issueAccessList reuses live links and replaces only unusable ones (D31, D59)", async () => {
    const before = (await listTokens(seeded.eventId, db)).filter((t) => t.status === "active");
    const result = await issueAccessList(db, seeded.eventId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(21);
    for (const row of result.data) {
      expect(row.link.startsWith(`${env.APP_URL}/s/`)).toBe(true);
      expect(row.email).toContain("@");
      expect(await verifyToken(db, row.link.split("/s/")[1])).not.toBeNull();
    }
    // A link issued at lock is handed out again, not rotated.
    const kept = issued[3];
    expect(result.data.map((r) => r.link)).toContain(linkFor(kept.token));
    expect(await verifyToken(db, kept.token)).not.toBeNull();

    // The token inserted without ciphertext (pepper test) can't be printed, so it is replaced.
    const after = await listTokens(seeded.eventId, db);
    const legacy = before.filter((t) => !after.some((a) => a.id === t.id && a.status === "active"));
    expect(legacy).toHaveLength(1);
    expect(legacy[0].entityId).toBe(seeded.buyers[1].id);
    expect(after.filter((t) => t.status === "active")).toHaveLength(21);

    // A second call changes nothing.
    const again = await issueAccessList(db, seeded.eventId);
    expect(again.ok && again.data.map((r) => r.link).sort()).toEqual(result.data.map((r) => r.link).sort());
  });

  it("linksForContacts without issueMissing writes nothing", async () => {
    const count = async () => (await db.select().from(accessTokens).where(eq(accessTokens.eventId, seeded.eventId))).length;
    const total = await count();
    const fresh = await seedEvent(db);
    const none = await linksForContacts(db, fresh.eventId, [{ contactType: "buyer", entityId: fresh.buyers[0].id }], {
      issueMissing: false,
    });
    expect(none.ok && none.data.size).toBe(0);
    expect(await count()).toBe(total);
  });
});
