import { createHash, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { admins, sessions, twoFactors } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { clearLoggedEmails, getLoggedEmails } from "@/lib/email/adapter";
import { env } from "@/lib/env";
import { listAudit } from "@/server/audit/audit";
import { describeAudit } from "@/server/audit/describe";
import { createInvite } from "./admins";
import { BREACHED_PASSWORD_MESSAGE } from "@/lib/schemas/auth";
import { createAuth, type Auth } from "./auth";
import { updateAdminName } from "./profile";

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "staple-lamp-orchard-9";

let db: Db;
let auth: Auth;
const founderId = "admin-founder";

/** Name=value pairs from Set-Cookie, without the ones being cleared. */
function cookiesFrom(response: Headers): string {
  return response
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

function inviteToken(): string {
  const token = getLoggedEmails().at(-1)?.text?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error("No invite link in the last email");
  return token;
}

/** An admin who accepted an invite with PASSWORD. */
async function createAdmin(email: string, authInstance: Auth = auth): Promise<string> {
  await createInvite(db, { email, name: "Dana Lee", invitedBy: founderId });
  const body = { email, password: PASSWORD, name: "Dana Lee", inviteToken: inviteToken() };
  const { user } = await authInstance.api.signUpEmail({ body: body as { email: string; password: string; name: string } });
  return user.id;
}

/** Signs in with email and password. `headers` carries whatever cookies the response set. */
async function signIn(email: string, password = PASSWORD) {
  const { headers, response } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return { headers: new Headers({ cookie: cookiesFrom(headers) }), response };
}

/** RFC 4648 base32, as in the `secret` of an `otpauth://` URI. */
function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** The code an authenticator app shows now for an `otpauth://` URI (RFC 6238, SHA-1, 30 s, 6 digits). */
function codeFor(totpURI: string): string {
  const key = base32Decode(new URL(totpURI).searchParams.get("secret")!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function twoFactorEnabled(adminId: string): Promise<boolean> {
  const [row] = await db.select({ on: admins.twoFactorEnabled }).from(admins).where(eq(admins.id, adminId));
  return row.on;
}

async function auditActions(adminId: string): Promise<string[]> {
  const { rows } = await listAudit({ eventId: null, filters: { entityId: adminId, actions: ["admin.two_factor_enable", "admin.two_factor_disable"] } }, db);
  return rows.map((r) => r.action).reverse();
}

/** Turns two-factor on for a signed-in admin and returns the URI, backup codes, and the rotated session's headers. */
async function turnOn(email: string) {
  const { headers } = await signIn(email);
  const setup = await auth.api.enableTwoFactor({ headers, body: { password: PASSWORD } });
  if (setup.method !== "totp" || !setup.totpURI || !setup.backupCodes) throw new Error("Expected a TOTP setup");
  const verified = await auth.api.verifyTOTP({
    headers,
    body: { code: codeFor(setup.totpURI) },
    returnHeaders: true,
  });
  return { totpURI: setup.totpURI, backupCodes: setup.backupCodes, headers: new Headers({ cookie: cookiesFrom(verified.headers) }) };
}

beforeAll(async () => {
  db = await createTestDb();
  auth = createAuth(db);
  await db.insert(admins).values({ id: founderId, name: "Founder", email: "founder@example.com" });
});

beforeEach(() => {
  clearLoggedEmails();
});

describe("two-factor sign-in", () => {
  it("turns on only after a code from the app is verified, and audits it once", async () => {
    const adminId = await createAdmin("setup@example.com");
    const { headers } = await signIn("setup@example.com");

    await expect(auth.api.enableTwoFactor({ headers, body: { password: "wrong-password-1" } })).rejects.toThrow();
    const setup = await auth.api.enableTwoFactor({ headers, body: { password: PASSWORD } });
    if (setup.method !== "totp" || !setup.totpURI) throw new Error("Expected a TOTP setup");
    expect(setup.totpURI).toMatch(/^otpauth:\/\/totp\/AW%20appointment%20matching:setup%40example\.com\?/);
    expect(setup.backupCodes).toHaveLength(10);

    // Scanning alone changes nothing: sign-in still takes only the password.
    expect(await twoFactorEnabled(adminId)).toBe(false);
    const [pending] = await db.select().from(twoFactors).where(eq(twoFactors.userId, adminId));
    expect(pending.verified).toBe(false);
    expect(pending.secret).not.toContain(new URL(setup.totpURI).searchParams.get("secret"));
    expect((await signIn("setup@example.com")).response).not.toHaveProperty("twoFactorRedirect");

    await expect(auth.api.verifyTOTP({ headers, body: { code: "000000" } })).rejects.toThrow(/invalid code/i);
    expect(await twoFactorEnabled(adminId)).toBe(false);

    await auth.api.verifyTOTP({ headers, body: { code: codeFor(setup.totpURI) } });
    expect(await twoFactorEnabled(adminId)).toBe(true);
    expect(await auditActions(adminId)).toEqual(["admin.two_factor_enable"]);
  });

  it("asks for a code after the password, then signs in", async () => {
    const adminId = await createAdmin("signin@example.com");
    const { totpURI } = await turnOn("signin@example.com");
    const before = (await db.select().from(sessions).where(eq(sessions.userId, adminId))).length;

    const { headers, response } = await signIn("signin@example.com");
    expect(response).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    // The password alone starts no session.
    expect(await db.select().from(sessions).where(eq(sessions.userId, adminId))).toHaveLength(before);
    expect(await auth.api.getSession({ headers })).toBeNull();

    await expect(auth.api.verifyTOTP({ headers, body: { code: "000000" } })).rejects.toThrow(/invalid code/i);
    const signedIn = await auth.api.verifyTOTP({ headers, body: { code: codeFor(totpURI) }, returnHeaders: true });
    expect(signedIn.response.user.id).toBe(adminId);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesFrom(signedIn.headers) }) });
    expect(session?.user.id).toBe(adminId);

    // The pending sign-in is used up.
    await expect(auth.api.verifyTOTP({ headers, body: { code: codeFor(totpURI) } })).rejects.toThrow();
  });

  it("refuses to remember a device, so a later sign-in still asks for a code", async () => {
    await createAdmin("trust@example.com");
    const { totpURI } = await turnOn("trust@example.com");
    const { headers } = await signIn("trust@example.com");

    await expect(
      auth.api.verifyTOTP({ headers, body: { code: codeFor(totpURI), trustDevice: true } }),
    ).rejects.toThrow(/doesn't remember devices/);
    await expect(
      auth.api.verifyBackupCode({ headers, body: { code: "aaaaa-bbbbb", trustDevice: true } }),
    ).rejects.toThrow(/doesn't remember devices/);

    const signedIn = await auth.api.verifyTOTP({ headers, body: { code: codeFor(totpURI) }, returnHeaders: true });
    expect(signedIn.headers.getSetCookie().some((line) => line.includes("trust_device="))).toBe(false);
    const again = await signIn("trust@example.com");
    expect(again.response).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
  });

  it("ends a pending sign-in after five wrong codes", async () => {
    await createAdmin("guess@example.com");
    const { totpURI } = await turnOn("guess@example.com");
    const { headers } = await signIn("guess@example.com");
    for (let i = 0; i < 5; i++) {
      await expect(auth.api.verifyTOTP({ headers, body: { code: "000000" } })).rejects.toThrow(/invalid code/i);
    }
    await expect(auth.api.verifyTOTP({ headers, body: { code: codeFor(totpURI) } })).rejects.toThrow(
      /too many attempts/i,
    );
  });

  it("takes each backup code once, and new codes replace the old ones", async () => {
    const adminId = await createAdmin("backup@example.com");
    const { backupCodes, headers: sessionHeaders } = await turnOn("backup@example.com");

    const first = await signIn("backup@example.com");
    const signedIn = await auth.api.verifyBackupCode({ headers: first.headers, body: { code: backupCodes[0] } });
    expect(signedIn.user.id).toBe(adminId);

    const again = await signIn("backup@example.com");
    await expect(
      auth.api.verifyBackupCode({ headers: again.headers, body: { code: backupCodes[0] } }),
    ).rejects.toThrow(/invalid backup code/i);

    await expect(
      auth.api.generateBackupCodes({ headers: sessionHeaders, body: { password: "wrong-password-1" } }),
    ).rejects.toThrow();
    const fresh = await auth.api.generateBackupCodes({ headers: sessionHeaders, body: { password: PASSWORD } });
    expect(fresh.backupCodes).toHaveLength(10);
    await expect(
      auth.api.verifyBackupCode({ headers: again.headers, body: { code: backupCodes[1] } }),
    ).rejects.toThrow(/invalid backup code/i);
    expect((await auth.api.verifyBackupCode({ headers: again.headers, body: { code: fresh.backupCodes[0] } })).user.id).toBe(
      adminId,
    );
  });

  it("turns off with the password, audits it once, and sign-in takes the password alone again", async () => {
    const adminId = await createAdmin("off@example.com");
    const { headers } = await turnOn("off@example.com");

    await expect(auth.api.disableTwoFactor({ headers, body: { password: "wrong-password-1" } })).rejects.toThrow();
    expect(await twoFactorEnabled(adminId)).toBe(true);

    await auth.api.disableTwoFactor({ headers, body: { password: PASSWORD } });
    expect(await twoFactorEnabled(adminId)).toBe(false);
    expect(await db.select().from(twoFactors).where(eq(twoFactors.userId, adminId))).toHaveLength(0);
    expect(await auditActions(adminId)).toEqual(["admin.two_factor_enable", "admin.two_factor_disable"]);

    const { response } = await signIn("off@example.com");
    expect(response).not.toHaveProperty("twoFactorRedirect");
    expect(response).toHaveProperty("user.id", adminId);
  });

  it("still refuses a disabled admin, before any code is asked for", async () => {
    const adminId = await createAdmin("gone@example.com");
    await turnOn("gone@example.com");
    await db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, adminId));
    await expect(signIn("gone@example.com")).rejects.toThrow(/disabled/i);
  });

  it("describes the audit rows", () => {
    const row = (action: string) => ({ action, entityType: "admin", entityId: null, before: null, after: null, note: null });
    expect(describeAudit(row("admin.two_factor_enable"), new Map())).toBe("Turned on two-factor sign-in");
    expect(describeAudit(row("admin.two_factor_disable"), new Map())).toBe("Turned off two-factor sign-in");
  });
});

describe("breached passwords", () => {
  function sha1(text: string): string {
    return createHash("sha1").update(text).digest("hex").toUpperCase();
  }

  /** Stands in for the range API: every password in `breached` appears in the corpus. */
  function stubRangeApi(breached: string[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const prefix = String(input).split("/range/")[1];
      const lines = breached.map(sha1).filter((hash) => hash.startsWith(prefix)).map((hash) => `${hash.slice(5)}:42`);
      lines.push("0000000000000000000000000000000000A:0");
      return new Response(lines.join("\r\n"), { status: 200, headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off in tests unless asked for, so the suite never reaches the network", async () => {
    const fetchMock = stubRangeApi([NEW_PASSWORD]);
    await createAdmin("offline@example.com");
    const { headers } = await signIn("offline@example.com");
    await auth.api.changePassword({ headers, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a breached password on sign-up, reset, and change, sending only a hash prefix", async () => {
    const checked = createAuth(db, { checkBreachedPasswords: true });
    const fetchMock = stubRangeApi([PASSWORD, NEW_PASSWORD]);

    await createInvite(db, { email: "breached@example.com", name: "Breached", invitedBy: founderId });
    const body = { email: "breached@example.com", password: PASSWORD, name: "Breached", inviteToken: inviteToken() };
    await expect(
      checked.api.signUpEmail({ body: body as { email: string; password: string; name: string } }),
    ).rejects.toThrow(BREACHED_PASSWORD_MESSAGE);
    expect(await db.select().from(admins).where(eq(admins.email, "breached@example.com"))).toHaveLength(0);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1(PASSWORD).slice(0, 5)}`);
    expect(url).not.toContain(sha1(PASSWORD).slice(5));

    // A password that isn't in the corpus goes through.
    const adminId = await createAdmin("clean@example.com");
    const [account] = await db.select().from(admins).where(eq(admins.id, adminId));
    expect(account).toBeDefined();
    const { headers } = await signIn("clean@example.com");
    await expect(
      checked.api.changePassword({ headers, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } }),
    ).rejects.toThrow(BREACHED_PASSWORD_MESSAGE);
    await checked.api.changePassword({ headers, body: { currentPassword: PASSWORD, newPassword: "unbreached-pass-77" } });

    clearLoggedEmails();
    await checked.api.requestPasswordReset({ body: { email: "clean@example.com", redirectTo: "/reset-password" } });
    const token = getLoggedEmails().at(-1)?.text?.match(/\/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();
    await expect(
      checked.api.resetPassword({ body: { token: token!, newPassword: NEW_PASSWORD } }),
    ).rejects.toThrow(BREACHED_PASSWORD_MESSAGE);
    // The refusal doesn't use up the link.
    await checked.api.resetPassword({ body: { token: token!, newPassword: "another-clean-one-5" } });
    await expect(
      checked.api.resetPassword({ body: { token: token!, newPassword: "another-clean-one-6" } }),
    ).rejects.toThrow(/invalid token/i);
  });

  it("checks a reset once, before the link is used, so a breach service outage leaves the link working", async () => {
    const checked = createAuth(db, { checkBreachedPasswords: true });
    await createAdmin("reset-outage@example.com");
    clearLoggedEmails();
    await checked.api.requestPasswordReset({ body: { email: "reset-outage@example.com", redirectTo: "/reset-password" } });
    const token = getLoggedEmails().at(-1)?.text?.match(/\/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();

    const down = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", down);
    await expect(
      checked.api.resetPassword({ body: { token: token!, newPassword: "outage-pass-123" } }),
    ).rejects.toThrow(/Failed to check password/);
    expect(down).toHaveBeenCalledTimes(1);

    const fetchMock = stubRangeApi([]);
    await checked.api.resetPassword({ body: { token: token!, newPassword: "outage-pass-123" } });
    // One breach request per reset: the plugin doesn't check resets a second time.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks a reset whose token comes in the query string, not the body", async () => {
    const checked = createAuth(db, { checkBreachedPasswords: true });
    await createAdmin("reset-query@example.com");
    clearLoggedEmails();
    await checked.api.requestPasswordReset({ body: { email: "reset-query@example.com", redirectTo: "/reset-password" } });
    const token = getLoggedEmails().at(-1)?.text?.match(/\/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();

    stubRangeApi([NEW_PASSWORD]);
    await expect(
      checked.api.resetPassword({ body: { newPassword: NEW_PASSWORD }, query: { token: token! } }),
    ).rejects.toThrow(BREACHED_PASSWORD_MESSAGE);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(
      checked.api.resetPassword({ body: { newPassword: "query-pass-12345" }, query: { token: token! } }),
    ).rejects.toThrow(/Failed to check password/);

    // Neither refusal used up the link.
    stubRangeApi([]);
    await checked.api.resetPassword({ body: { newPassword: "query-pass-12345" }, query: { token: token! } });
  });
});

describe("password reset email", () => {
  it("goes to an active admin and names the product", async () => {
    await createAdmin("reset@example.com");
    clearLoggedEmails();
    await auth.api.requestPasswordReset({ body: { email: "reset@example.com", redirectTo: "/reset-password" } });
    const emails = getLoggedEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe("Reset your AW appointment matching password");
  });

  it("is never sent to a disabled admin, and the request still looks the same", async () => {
    const adminId = await createAdmin("disabled-reset@example.com");
    await db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, adminId));
    clearLoggedEmails();
    const result = await auth.api.requestPasswordReset({
      body: { email: "disabled-reset@example.com", redirectTo: "/reset-password" },
    });
    const unknown = await auth.api.requestPasswordReset({
      body: { email: "nobody@example.com", redirectTo: "/reset-password" },
    });
    expect(result).toEqual(unknown);
    expect(getLoggedEmails()).toHaveLength(0);
  });
});

describe("Better Auth routes", () => {
  const route = (path: string, init: { cookie?: string; body: unknown; ip?: string }) =>
    auth.handler(
      new Request(`${env.APP_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: env.APP_URL,
          "x-forwarded-for": init.ip ?? "203.0.113.7",
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: JSON.stringify(init.body),
      }),
    );

  it("refuses /update-user, so names change only through the audited profile action", async () => {
    const adminId = await createAdmin("rename@example.com");
    const { headers } = await signIn("rename@example.com");
    const response = await route("/update-user", { cookie: headers.get("cookie")!, body: { name: "Mallory" } });
    expect(response.status).toBe(404);
    const [row] = await db.select({ name: admins.name }).from(admins).where(eq(admins.id, adminId));
    expect(row.name).toBe("Dana Lee");

    expect(await updateAdminName(db, { adminId, name: "Dana Lee-Okafor" })).toEqual({
      ok: true,
      data: { name: "Dana Lee-Okafor" },
    });
  });

  it("limits /change-password to 5 tries per 10 minutes", async () => {
    await createAdmin("hammer@example.com");
    const { headers } = await signIn("hammer@example.com");
    const body = { currentPassword: "not-the-password", newPassword: NEW_PASSWORD };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await route("/change-password", { cookie: headers.get("cookie")!, body, ip: "198.51.100.9" })).status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
