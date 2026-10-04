import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { adminInvites, admins, sessions } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { clearLoggedEmails, getLoggedEmails } from "@/lib/email/adapter";
import { listAudit } from "@/server/audit/audit";
import { createInvite, disableAdminAccount, enableAdminAccount, hashToken, resendInvite } from "./admins";
import { createAuth, getAuth, type Auth } from "./auth";
import { getInviteByToken, listAdmins } from "./queries";

const PASSWORD = "correct-horse-battery";

let db: Db;
let auth: Auth;

async function seedFirstAdmin(email: string) {
  const id = `admin-${email}`;
  await db.insert(admins).values({ id, name: "Founder", email });
  return id;
}

/** Sign-up body with the invite token. Better Auth passes extra body keys through to the create hook untyped. */
function signUpBody(email: string, name: string, inviteToken: string | undefined) {
  const body = { email, password: PASSWORD, name, inviteToken };
  return body as { email: string; password: string; name: string };
}

function inviteTokenFromEmail(): string {
  const last = getLoggedEmails().at(-1);
  const match = last?.text?.match(/\/invite\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("No invite link in the last email");
  return match[1];
}

beforeAll(async () => {
  db = await createTestDb();
  auth = createAuth(db);
});

beforeEach(() => {
  clearLoggedEmails();
});

describe("sign up", () => {
  it("fails without an invite", async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: "stranger@example.com", password: PASSWORD, name: "Stranger" },
      }),
    ).rejects.toThrow(/invitation/i);
    expect(await db.select().from(admins).where(eq(admins.email, "stranger@example.com"))).toHaveLength(0);
  });

  it("succeeds with a pending invite, marks it accepted, and records who invited", async () => {
    const founderId = await seedFirstAdmin("founder@example.com");
    const invite = await createInvite(db, { email: "New@Example.com", name: "New Admin", invitedBy: founderId });
    expect(invite.ok).toBe(true);
    expect(getLoggedEmails()).toHaveLength(1);

    const token = inviteTokenFromEmail();
    const byToken = await getInviteByToken(token, db);
    expect(byToken?.email).toBe("new@example.com");
    expect(await getInviteByToken("not-a-real-token", db)).toBeNull();

    const result = await auth.api.signUpEmail({
      body: signUpBody("new@example.com", "New Admin", token),
    });
    expect(result.user.email).toBe("new@example.com");
    expect(result.user).not.toHaveProperty("inviteToken");

    const [row] = await db.select().from(admins).where(eq(admins.email, "new@example.com"));
    expect(row.invitedBy).toBe(founderId);
    expect(row.disabledAt).toBeNull();

    const [inviteRow] = await db.select().from(adminInvites).where(eq(adminInvites.email, "new@example.com"));
    expect(inviteRow.acceptedAt).not.toBeNull();
    expect(await getInviteByToken(token, db)).toBeNull();

    const audit = await listAudit({ eventId: null }, db);
    expect(audit.rows.map((r) => r.action)).toEqual(["admin.accept_invite", "admin.invite"]);
  });

  it("fails with a missing, wrong, or another person's token", async () => {
    const founderId = "admin-founder@example.com";
    await createInvite(db, { email: "victim@example.com", name: "Victim", invitedBy: founderId });
    const victimToken = inviteTokenFromEmail();
    await createInvite(db, { email: "attacker@example.com", name: "Attacker", invitedBy: founderId });
    const attackerToken = inviteTokenFromEmail();

    for (const inviteToken of [undefined, "", "not-a-real-token", attackerToken]) {
      await expect(
        auth.api.signUpEmail({
          body: signUpBody("victim@example.com", "Victim", inviteToken),
        }),
      ).rejects.toThrow(/invitation/i);
    }
    expect(await db.select().from(admins).where(eq(admins.email, "victim@example.com"))).toHaveLength(0);

    const ok = await auth.api.signUpEmail({
      body: signUpBody("victim@example.com", "Victim", victimToken),
    });
    expect(ok.user.email).toBe("victim@example.com");
    // Later tests count active admins; keep this one out of them.
    await db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, ok.user.id));
  });

  it("fails with a token that was already used", async () => {
    const founderId = "admin-founder@example.com";
    await createInvite(db, { email: "once@example.com", name: "Once", invitedBy: founderId });
    const token = inviteTokenFromEmail();
    const first = await auth.api.signUpEmail({
      body: signUpBody("once@example.com", "Once", token),
    });
    // Free the email and retire the account so only the used invite can stop the second attempt.
    await db
      .update(admins)
      .set({ email: "once-renamed@example.com", disabledAt: new Date() })
      .where(eq(admins.id, first.user.id));
    await expect(
      auth.api.signUpEmail({
        body: signUpBody("once@example.com", "Once", token),
      }),
    ).rejects.toThrow(/invitation/i);
  });

  it("refuses a second pending invite for the same email, and an invite for an existing admin", async () => {
    const founderId = "admin-founder@example.com";
    const first = await createInvite(db, { email: "twice@example.com", name: "Twice", invitedBy: founderId });
    expect(first.ok).toBe(true);
    const second = await createInvite(db, { email: "twice@example.com", name: "Twice", invitedBy: founderId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");

    const existing = await createInvite(db, { email: "new@example.com", name: "New", invitedBy: founderId });
    expect(existing.ok).toBe(false);
  });

  it("resend rotates the token", async () => {
    const founderId = "admin-founder@example.com";
    const { invites } = await listAdmins(db);
    const pending = invites.find((i) => i.email === "twice@example.com");
    expect(pending).toBeDefined();
    const [before] = await db.select().from(adminInvites).where(eq(adminInvites.id, pending!.id));

    const result = await resendInvite(db, { inviteId: pending!.id, actorId: founderId });
    expect(result.ok).toBe(true);
    const newToken = inviteTokenFromEmail();
    const [after] = await db.select().from(adminInvites).where(eq(adminInvites.id, pending!.id));
    expect(after.tokenHash).toBe(hashToken(newToken));
    expect(after.tokenHash).not.toBe(before.tokenHash);
    expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(before.expiresAt.getTime());
    expect((await getInviteByToken(newToken, db))?.id).toBe(pending!.id);
  });
});

describe("sign in", () => {
  it("works for an active admin and is blocked once disabled", async () => {
    const signedIn = await auth.api.signInEmail({
      body: { email: "new@example.com", password: PASSWORD },
    });
    expect(signedIn.user.email).toBe("new@example.com");
    const userId = signedIn.user.id;
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).not.toHaveLength(0);

    const disabled = await disableAdminAccount(db, { userId, actorId: "admin-founder@example.com" });
    expect(disabled.ok).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);

    await expect(
      auth.api.signInEmail({ body: { email: "new@example.com", password: PASSWORD } }),
    ).rejects.toThrow(/disabled/i);

    const enabled = await enableAdminAccount(db, { userId, actorId: "admin-founder@example.com" });
    expect(enabled.ok).toBe(true);
    const again = await auth.api.signInEmail({ body: { email: "new@example.com", password: PASSWORD } });
    expect(again.user.id).toBe(userId);
  });
});

describe("disable rules", () => {
  it("refuses to disable yourself", async () => {
    const result = await disableAdminAccount(db, { userId: "admin-x", actorId: "admin-x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("refuses to disable the last active admin", async () => {
    const founderId = "admin-founder@example.com";
    const [other] = await db.select().from(admins).where(eq(admins.email, "new@example.com"));

    const first = await disableAdminAccount(db, { userId: other.id, actorId: founderId });
    expect(first.ok).toBe(true);

    const last = await disableAdminAccount(db, { userId: founderId, actorId: other.id });
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.error.code).toBe("conflict");

    const { admins: list } = await listAdmins(db);
    expect(list.find((a) => a.id === founderId)?.disabledAt).toBeNull();
    expect(list.find((a) => a.id === other.id)?.disabledAt).not.toBeNull();
  });

  it("returns not_found for unknown users", async () => {
    const result = await disableAdminAccount(db, { userId: "ghost", actorId: "admin-founder@example.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("getAuth", () => {
  it("binds to the injected test db", async () => {
    const instance = getAuth();
    expect(getAuth()).toBe(instance);
    const session = await instance.api.getSession({ headers: new Headers() });
    expect(session).toBeNull();
  });
});
