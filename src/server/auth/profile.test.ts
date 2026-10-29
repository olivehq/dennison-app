import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { admins, rateLimits, sessions } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { getLoggedEmails } from "@/lib/email/adapter";
import { BREACH_CHECK_UNAVAILABLE_MESSAGE, BREACHED_PASSWORD_MESSAGE } from "@/lib/schemas/auth";
import { listAudit } from "@/server/audit/audit";
import { createInvite } from "./admins";
import { createAuth, type Auth } from "./auth";
import { changeAdminPassword, endOtherSessions, updateAdminName } from "./profile";
import { listAdminSessions } from "./queries";

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "staple-lamp-orchard-9";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

let db: Db;
let auth: Auth;
let founderId: string;

/** An admin who accepted an invite with PASSWORD. */
async function createAdmin(email: string, name = "Dana Lee"): Promise<string> {
  await createInvite(db, { email, name, invitedBy: founderId });
  const token = getLoggedEmails().at(-1)?.text?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  const body = { email, password: PASSWORD, name, inviteToken: token } as { email: string; password: string; name: string };
  const { user } = await auth.api.signUpEmail({ body });
  return user.id;
}

/** Signs in from a browser and returns its session id and the request headers that carry its cookie. */
async function signIn(email: string, userAgent: string, password = PASSWORD) {
  const { headers: response, response: body } = await auth.api.signInEmail({
    body: { email, password },
    headers: new Headers({ "user-agent": userAgent }),
    returnHeaders: true,
  });
  const cookie = response
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.token, body.token));
  return { sessionId: row.id, headers: new Headers({ cookie, "user-agent": userAgent }) };
}

async function sessionIds(adminId: string): Promise<string[]> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, adminId));
  return rows.map((r) => r.id).sort();
}

beforeAll(async () => {
  db = await createTestDb();
  auth = createAuth(db);
  founderId = "admin-founder";
  await db.insert(admins).values({ id: founderId, name: "Founder", email: "founder@example.com" });
});

describe("updateAdminName", () => {
  it("saves the name and audits the before and after", async () => {
    const adminId = await createAdmin("name@example.com", "Dana Lee");
    expect(await updateAdminName(db, { adminId, name: "Dana Lee-Okafor" })).toEqual({
      ok: true,
      data: { name: "Dana Lee-Okafor" },
    });
    const [row] = await db.select({ name: admins.name }).from(admins).where(eq(admins.id, adminId));
    expect(row.name).toBe("Dana Lee-Okafor");

    // Saving the same name again changes nothing and writes no second row.
    expect((await updateAdminName(db, { adminId, name: "Dana Lee-Okafor" })).ok).toBe(true);
    const audit = await listAudit({ eventId: null, filters: { action: "admin.profile_update", entityId: adminId } }, db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      adminId,
      before: { name: "Dana Lee" },
      after: { name: "Dana Lee-Okafor" },
    });
  });

  it("refuses an account that no longer exists", async () => {
    expect(await updateAdminName(db, { adminId: "ghost", name: "Ghost" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("changeAdminPassword with the breached-password check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function attempt(email: string) {
    const checked = createAuth(db, { checkBreachedPasswords: true });
    const adminId = await createAdmin(email);
    const here = await signIn(email, MAC_CHROME);
    return changeAdminPassword(checked, db, {
      adminId,
      headers: here.headers,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: false,
    });
  }

  it("shows the breach message on the new password field instead of throwing", async () => {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1").update(NEW_PASSWORD).digest("hex").toUpperCase();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${hash.slice(5)}:42`, { status: 200 })));
    const result = await attempt("breached-change@example.com");
    expect(result).toEqual({
      ok: false,
      error: { code: "validation", message: "Check the highlighted fields.", fieldErrors: { newPassword: [BREACHED_PASSWORD_MESSAGE] } },
    });
  });

  it("says to try again when the breach service can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const result = await attempt("breach-down@example.com");
    expect(result).toEqual({ ok: false, error: { code: "internal", message: BREACH_CHECK_UNAVAILABLE_MESSAGE } });
  });
});

describe("changeAdminPassword", () => {
  it("says what to do when the current password is wrong, and changes nothing", async () => {
    const adminId = await createAdmin("wrong@example.com");
    const here = await signIn("wrong@example.com", MAC_CHROME);
    const result = await changeAdminPassword(auth, db, {
      adminId,
      headers: here.headers,
      currentPassword: "not-my-password",
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
    if (!result.ok) {
      expect(result.error.fieldErrors?.currentPassword?.[0]).toMatch(/isn't your current password.*Forgot password/);
    }
    await expect(auth.api.signInEmail({ body: { email: "wrong@example.com", password: PASSWORD } })).resolves.toBeTruthy();
    const audit = await listAudit({ eventId: null, filters: { action: "admin.password_change", entityId: adminId } }, db);
    expect(audit.rows).toHaveLength(0);
  });

  it("changes the password, signs out the other sessions, and audits without secrets", async () => {
    const adminId = await createAdmin("change@example.com");
    const here = await signIn("change@example.com", MAC_CHROME);
    await signIn("change@example.com", IPHONE_SAFARI);
    expect(await sessionIds(adminId)).toHaveLength(3); // sign-up, Mac, iPhone

    const result = await changeAdminPassword(auth, db, {
      adminId,
      headers: here.headers,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(result).toEqual({ ok: true, data: { otherSessionsSignedOut: true } });

    // Every old session is gone; Better Auth started one fresh session for this browser.
    const remaining = await sessionIds(adminId);
    expect(remaining).toHaveLength(1);
    expect(remaining).not.toContain(here.sessionId);

    await expect(auth.api.signInEmail({ body: { email: "change@example.com", password: PASSWORD } })).rejects.toThrow();
    await expect(
      auth.api.signInEmail({ body: { email: "change@example.com", password: NEW_PASSWORD } }),
    ).resolves.toBeTruthy();

    const audit = await listAudit({ eventId: null, filters: { action: "admin.password_change", entityId: adminId } }, db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ adminId, after: { otherSessionsSignedOut: true } });
    const stored = JSON.stringify(audit.rows[0]);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(NEW_PASSWORD);
  });

  it("keeps the other sessions when asked to", async () => {
    const adminId = await createAdmin("keep@example.com");
    const here = await signIn("keep@example.com", MAC_CHROME);
    const before = await sessionIds(adminId);
    const result = await changeAdminPassword(auth, db, {
      adminId,
      headers: here.headers,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: false,
    });
    expect(result).toEqual({ ok: true, data: { otherSessionsSignedOut: false } });
    expect(await sessionIds(adminId)).toEqual(before);
  });

  it("stops after five tries in 10 minutes", async () => {
    const adminId = await createAdmin("guess@example.com");
    const here = await signIn("guess@example.com", MAC_CHROME);
    const attempt = () =>
      changeAdminPassword(auth, db, {
        adminId,
        headers: here.headers,
        currentPassword: "a-wrong-guess",
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: false,
      });
    for (let i = 0; i < 5; i++) {
      expect(await attempt()).toMatchObject({ ok: false, error: { code: "validation" } });
    }
    const blocked = await attempt();
    expect(blocked).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    if (!blocked.ok) expect(blocked.error.message).toMatch(/^Too many tries\. Wait (a minute|\d+ minutes), then try again\.$/);
  });
});

describe("persistent password attempts", () => {
  it("shares the limit across auth instances and concurrent requests, then expires it", async () => {
    const adminId = await createAdmin("persistent@example.com");
    const api = { api: { changePassword: vi.fn().mockRejectedValue(new Error("attempt reached auth")) } } as unknown as Auth;
    const input = { adminId, headers: new Headers(), currentPassword: "wrong", newPassword: NEW_PASSWORD, revokeOtherSessions: false };
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => changeAdminPassword(api, db, input)));
    expect(api.api.changePassword).toHaveBeenCalledTimes(5);
    expect(results.filter((r) => r.status === "fulfilled" && !r.value.ok && r.value.error.code === "rate_limited")).toHaveLength(4);
    const secondInstance = { api: { changePassword: vi.fn() } } as unknown as Auth;
    expect(await changeAdminPassword(secondInstance, db, input)).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(secondInstance.api.changePassword).not.toHaveBeenCalled();
    await db.update(rateLimits).set({ lastRequest: Date.now() - 10 * 60 * 1000 - 1 }).where(eq(rateLimits.key, `admin-password-change:${adminId}`));
    expect((await changeAdminPassword(secondInstance, db, input)).ok).toBe(true);
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, `admin-password-change:${adminId}`));
    expect(row.count).toBe(1);
  });

  it("refuses disabled accounts before profile mutations or password checks", async () => {
    const adminId = await createAdmin("disabled-profile@example.com");
    await db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, adminId));
    const api = { api: { changePassword: vi.fn() } } as unknown as Auth;
    expect(await updateAdminName(db, { adminId, name: "Changed" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await changeAdminPassword(api, db, { adminId, headers: new Headers(), currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(api.api.changePassword).not.toHaveBeenCalled();
    expect(await endOtherSessions(db, { adminId, currentSessionId: "unused" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await sessionIds(adminId)).toHaveLength(1);
    const [row] = await db.select().from(admins).where(eq(admins.id, adminId));
    expect(row.name).toBe("Dana Lee");
  });
});

describe("sessions", () => {
  it("lists this browser first with a readable device and nothing secret", async () => {
    const adminId = await createAdmin("list@example.com");
    await db.delete(sessions).where(eq(sessions.userId, adminId));
    const phone = await signIn("list@example.com", IPHONE_SAFARI);
    const here = await signIn("list@example.com", MAC_CHROME);
    // The phone was used more recently than this browser.
    await db.update(sessions).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(sessions.id, phone.sessionId));

    const list = await listAdminSessions({ adminId, currentSessionId: here.sessionId }, db);
    expect(list.map((s) => [s.device, s.current])).toEqual([
      ["Chrome on macOS", true],
      ["Safari on iPhone", false],
    ]);
    expect(Object.keys(list[0]).sort()).toEqual(["current", "device", "id", "lastActiveAt", "signedInAt"]);

    // An expired session is not listed.
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, phone.sessionId));
    expect(await listAdminSessions({ adminId, currentSessionId: here.sessionId }, db)).toHaveLength(1);
  });

  it("signs out one other session, then all the others, never this one", async () => {
    const adminId = await createAdmin("out@example.com");
    await db.delete(sessions).where(eq(sessions.userId, adminId));
    const here = await signIn("out@example.com", MAC_CHROME);
    const phone = await signIn("out@example.com", IPHONE_SAFARI);
    const third = await signIn("out@example.com", "curl/8.7.1");

    expect(
      await endOtherSessions(db, { adminId, currentSessionId: here.sessionId, sessionId: phone.sessionId }),
    ).toEqual({ ok: true, data: { count: 1 } });
    expect(await sessionIds(adminId)).toEqual([here.sessionId, third.sessionId].sort());

    // Again: the phone's session is already gone.
    expect(
      await endOtherSessions(db, { adminId, currentSessionId: here.sessionId, sessionId: phone.sessionId }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    // This browser can't be signed out from here.
    expect(
      await endOtherSessions(db, { adminId, currentSessionId: here.sessionId, sessionId: here.sessionId }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });

    expect(await endOtherSessions(db, { adminId, currentSessionId: here.sessionId })).toEqual({
      ok: true,
      data: { count: 1 },
    });
    expect(await sessionIds(adminId)).toEqual([here.sessionId]);
    // Nothing left to sign out: no change, no audit row.
    expect(await endOtherSessions(db, { adminId, currentSessionId: here.sessionId })).toEqual({
      ok: true,
      data: { count: 0 },
    });

    const audit = await listAudit({ eventId: null, filters: { action: "admin.sessions_sign_out", entityId: adminId } }, db);
    expect(audit.rows.map((r) => r.after)).toEqual([
      { count: 1, devices: ["Unknown browser"] },
      { count: 1, devices: ["Safari on iPhone"] },
    ]);
  });

  it("can't touch another admin's session", async () => {
    const mine = await createAdmin("mine@example.com");
    await createAdmin("theirs@example.com");
    const here = await signIn("mine@example.com", MAC_CHROME);
    const theirs = await signIn("theirs@example.com", IPHONE_SAFARI);

    expect(
      await endOtherSessions(db, { adminId: mine, currentSessionId: here.sessionId, sessionId: theirs.sessionId }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const [still] = await db.select().from(sessions).where(eq(sessions.id, theirs.sessionId));
    expect(still).toBeDefined();
  });
});
