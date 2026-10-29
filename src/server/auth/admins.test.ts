import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { adminInvites, admins, sessions, twoFactors } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { clearLoggedEmails, getLoggedEmails } from "@/lib/email/adapter";
import { listAudit } from "@/server/audit/audit";
import { listAdmins } from "./queries";
import { createInvite, resendInvite, resetTwoFactor } from "./admins";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await db.insert(admins).values({ id: "active", name: "Dana", email: "active@example.com" });
  await db.insert(admins).values({ id: "disabled", name: "Disabled", email: "disabled@example.com", disabledAt: new Date() });
});
beforeEach(() => clearLoggedEmails());

it("does not invite disabled accounts or send invites on their behalf", async () => {
  expect(await createInvite(db, { email: "disabled@example.com", name: "Disabled", invitedBy: "active" }))
    .toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(await createInvite(db, { email: "new@example.com", name: "New", invitedBy: "disabled" }))
    .toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(getLoggedEmails()).toHaveLength(0);
});

it("does not resend a pending invite to an address that now has a disabled account", async () => {
  const result = await createInvite(db, { email: "pending@example.com", name: "Pending", invitedBy: "active" });
  if (!result.ok) throw new Error(result.error.message);
  await db.insert(admins).values({ id: "pending", name: "Pending", email: "pending@example.com", disabledAt: new Date() });
  clearLoggedEmails();
  const [before] = await db.select().from(adminInvites).where(eq(adminInvites.id, result.data.inviteId));
  expect(await resendInvite(db, { inviteId: result.data.inviteId, actorId: "active" }))
    .toMatchObject({ ok: false, error: { code: "conflict" } });
  const [after] = await db.select().from(adminInvites).where(eq(adminInvites.id, result.data.inviteId));
  expect(after.tokenHash).toBe(before.tokenHash);
  expect(getLoggedEmails()).toHaveLength(0);
});

it("uses the product name and refuses resend by a disabled sender", async () => {
  const result = await createInvite(db, { email: "wording@example.com", name: "New", invitedBy: "active" });
  if (!result.ok) throw new Error(result.error.message);
  const email = getLoggedEmails().at(-1)!;
  expect(email.subject).toBe("Dana invited you to AW appointment matching");
  expect(email.text).toContain("administer AW appointment matching");
  clearLoggedEmails();
  expect(await resendInvite(db, { inviteId: result.data.inviteId, actorId: "disabled" }))
    .toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(getLoggedEmails()).toHaveLength(0);
});

it("resets two-factor for an admin who lost their app and codes, signs them out, and audits it", async () => {
  await db.insert(admins).values({ id: "lost", name: "Lost", email: "lost@example.com", twoFactorEnabled: true });
  await db.insert(twoFactors).values({ id: "tf-lost", userId: "lost", secret: "x", backupCodes: "y" });
  await db.insert(sessions).values({
    id: "s-lost", userId: "lost", token: "t-lost", expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(),
  });

  expect(await resetTwoFactor(db, "LOST@example.com")).toEqual({ adminId: "lost", wasEnabled: true });
  const [admin] = await db.select().from(admins).where(eq(admins.id, "lost"));
  expect(admin.twoFactorEnabled).toBe(false);
  expect(await db.select().from(twoFactors).where(eq(twoFactors.userId, "lost"))).toHaveLength(0);
  expect(await db.select().from(sessions).where(eq(sessions.userId, "lost"))).toHaveLength(0);
  const audit = await listAudit({ eventId: null, filters: { action: "admin.two_factor_disable", entityId: "lost" } }, db);
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0].note).toMatch(/pnpm reset-two-factor/);

  expect(await resetTwoFactor(db, "nobody@example.com")).toBeNull();
});

it("records only the sign-out when two-factor was already off", async () => {
  await db.insert(admins).values({ id: "plain", name: "Plain", email: "plain@example.com" });
  const expiresAt = new Date(Date.now() + 3_600_000);
  for (const n of [1, 2]) {
    await db.insert(sessions).values({
      id: `s-plain-${n}`, userId: "plain", token: `t-plain-${n}`, expiresAt, createdAt: new Date(), updatedAt: new Date(),
    });
  }
  expect(await resetTwoFactor(db, "plain@example.com")).toEqual({ adminId: "plain", wasEnabled: false });
  expect(await db.select().from(sessions).where(eq(sessions.userId, "plain"))).toHaveLength(0);
  const turnedOff = await listAudit({ eventId: null, filters: { action: "admin.two_factor_disable", entityId: "plain" } }, db);
  expect(turnedOff.rows).toHaveLength(0);
  const signedOut = await listAudit({ eventId: null, filters: { action: "admin.sessions_sign_out", entityId: "plain" } }, db);
  expect(signedOut.rows).toHaveLength(1);
  expect(signedOut.rows[0].after).toEqual({ count: 2 });
});

it("hides revoked invite history only once its email has an admin", async () => {
  const result = await createInvite(db, { email: "history@example.com", name: "History", invitedBy: "active" });
  if (!result.ok) throw new Error(result.error.message);
  await db.update(adminInvites).set({ revokedAt: new Date() }).where(eq(adminInvites.id, result.data.inviteId));
  expect((await listAdmins(db)).invites.some((row) => row.id === result.data.inviteId)).toBe(true);
  await db.insert(admins).values({ id: "history", email: "history@example.com", name: "History" });
  expect((await listAdmins(db)).invites.some((row) => row.id === result.data.inviteId)).toBe(false);
});
