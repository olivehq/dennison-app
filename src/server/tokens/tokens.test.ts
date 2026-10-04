import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { accessTokens, auditEvents, events, participants } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { env } from "@/lib/env";
import { decryptToken, generateToken, hashToken } from "@/lib/tokens";
import { seedEvent, type Seeded } from "@/server/matching/test-seed";
import { issueAccessList, listTokens } from "./queries";
import {
  issueTokenForContact,
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
    // A supplier with no attendee contact, so no live link exists for it (one per contact).
    const noAttendee = seeded.suppliers.find((s) => !s.attendeeContactEmail)!;
    await db.insert(accessTokens).values({
      eventId: seeded.eventId,
      contactType: "supplier_attendee",
      entityId: noAttendee.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await verifyToken(db, token)).toBeNull();
  });

  it("rejects a token hashed under a different pepper", async () => {
    const token = generateToken();
    // One live link per contact: retire buyers[1]'s link before planting a legacy one.
    await db
      .update(accessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(accessTokens.entityId, seeded.buyers[1].id), isNull(accessTokens.revokedAt)));
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
    const revoked = await revokeToken(db, target.tokenId, null);
    expect(revoked.ok).toBe(true);
    expect(await verifyToken(db, target.token)).toBeNull();
    expect((await revokeToken(db, target.tokenId, null)).ok).toBe(true);

    const other = issued[2];
    const regenerated = await regenerateToken(db, other.tokenId, null);
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    expect(regenerated.data.previousTokenId).toBe(other.tokenId);
    expect(regenerated.data.tokenId).not.toBe(other.tokenId);
    expect(await verifyToken(db, other.token)).toBeNull();
    const verified = await verifyToken(db, regenerated.data.token);
    expect(verified?.contactType).toBe(other.contactType);
    expect(verified?.entityId).toBe(other.entityId);

    expect((await revokeToken(db, "00000000-0000-0000-0000-000000000000", null)).ok).toBe(false);
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

describe("one live link per contact", () => {
  it("issueTokenForContact reuses a live link instead of creating a second one", async () => {
    const fresh = await seedEvent(db);
    const buyer = fresh.buyers[0];
    const expiresAt = new Date(Date.now() + 86_400_000);
    // Another request issued this contact's link a moment ago.
    const first = await issueTokenForContact(db, { eventId: fresh.eventId, contactType: "buyer", entityId: buyer.id, expiresAt });
    const second = await issueTokenForContact(db, { eventId: fresh.eventId, contactType: "buyer", entityId: buyer.id, expiresAt });
    expect(second).toEqual(first);
    const live = await db
      .select()
      .from(accessTokens)
      .where(and(eq(accessTokens.entityId, buyer.id), isNull(accessTokens.revokedAt)));
    expect(live).toHaveLength(1);
    const duplicate = await db
      .insert(accessTokens)
      .values({ eventId: fresh.eventId, contactType: "buyer", entityId: buyer.id, tokenHash: "dup", expiresAt })
      .then(() => "inserted", () => "refused");
    expect(duplicate).toBe("refused");
  });

  it("revokes an expired unrevoked link before issuing, and replaces a link it can't decrypt", async () => {
    const fresh = await seedEvent(db);
    const buyer = fresh.buyers[1];
    const [expired] = await db
      .insert(accessTokens)
      .values({ eventId: fresh.eventId, contactType: "buyer", entityId: buyer.id, tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() - 1000) })
      .returning();
    const issued = await issueTokenForContact(db, {
      eventId: fresh.eventId,
      contactType: "buyer",
      entityId: buyer.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(issued.tokenId).not.toBe(expired.id);
    const [old] = await db.select().from(accessTokens).where(eq(accessTokens.id, expired.id));
    expect(old.revokedAt).not.toBeNull();

    // A live link from before D59 (no ciphertext) is retired and replaced.
    await db.update(accessTokens).set({ revokedAt: new Date() }).where(eq(accessTokens.id, issued.tokenId));
    const [legacy] = await db
      .insert(accessTokens)
      .values({ eventId: fresh.eventId, contactType: "buyer", entityId: buyer.id, tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) })
      .returning();
    const replaced = await issueTokenForContact(db, {
      eventId: fresh.eventId,
      contactType: "buyer",
      entityId: buyer.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(replaced.tokenId).not.toBe(legacy.id);
    expect(await verifyToken(db, replaced.token)).not.toBeNull();
  });
});

describe("regenerate and revoke rules", () => {
  it("audit in the same transaction, refuse a withdrawn person's new link, and refuse archived events", async () => {
    const fresh = await seedEvent(db);
    const result = await issueTokensForEvent(db, fresh.eventId);
    if (!result.ok) throw new Error(result.error.message);
    const target = result.data.find((t) => t.contactType === "buyer")!;

    const regenerated = await regenerateToken(db, target.tokenId, fresh.adminId);
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.entityId, regenerated.data.tokenId));
    expect(audit).toMatchObject({ action: "token.regenerate", adminId: fresh.adminId, before: { tokenId: target.tokenId } });

    // Withdrawn: no new link, but revoking still works.
    await db.update(participants).set({ status: "withdrawn" }).where(eq(participants.id, target.entityId));
    const refused = await regenerateToken(db, regenerated.data.tokenId, fresh.adminId);
    expect(!refused.ok && refused.error.code).toBe("conflict");
    const revoked = await revokeToken(db, regenerated.data.tokenId, fresh.adminId);
    expect(revoked.ok).toBe(true);
    const revokeAudit = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, regenerated.data.tokenId), eq(auditEvents.action, "token.revoke")));
    expect(revokeAudit).toHaveLength(1);
    // Revoking again is a no-op and writes no second row.
    await revokeToken(db, regenerated.data.tokenId, fresh.adminId);
    expect(await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, regenerated.data.tokenId), eq(auditEvents.action, "token.revoke")))).toHaveLength(1);

    // Locked events still allow link actions; archived ones don't.
    const other = result.data.find((t) => t.contactType === "supplier_admin")!;
    await db.update(events).set({ status: "locked" }).where(eq(events.id, fresh.eventId));
    expect((await regenerateToken(db, other.tokenId, fresh.adminId)).ok).toBe(true);
    await db.update(events).set({ status: "archived" }).where(eq(events.id, fresh.eventId));
    const live = await db
      .select()
      .from(accessTokens)
      .where(and(eq(accessTokens.entityId, other.entityId), eq(accessTokens.contactType, "supplier_admin"), isNull(accessTokens.revokedAt)));
    const archivedRegen = await regenerateToken(db, live[0].id, fresh.adminId);
    expect(!archivedRegen.ok && archivedRegen.error.code).toBe("locked");
    const archivedRevoke = await revokeToken(db, live[0].id, fresh.adminId);
    expect(!archivedRevoke.ok && archivedRevoke.error.code).toBe("locked");
  });
});

