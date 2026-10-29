import { beforeAll, expect, it } from "vitest";
import { createTestDb } from "@/db/test-db";
import { env } from "@/lib/env";
import { createAuth, type Auth } from "./auth";

let auth: Auth;
beforeAll(async () => { auth = createAuth(await createTestDb()); });

it("keeps strict limits on password and account routes", () => {
  for (const path of ["/sign-in/email", "/sign-up/email", "/request-password-reset", "/reset-password", "/change-password"] as const) {
    expect(auth.options.rateLimit?.customRules?.[path]).toEqual({ window: 600, max: 5 });
  }
});

it("allows ordinary fast browsing past the default session route limit", async () => {
  for (let i = 0; i < 105; i++) {
    const response = await auth.handler(new Request(`${env.APP_URL}/api/auth/get-session`));
    expect(response.status).toBe(200);
  }
});

it.each(["verify-totp", "verify-backup-code"])("overrides the plugin's three-request limit for %s", async (route) => {
  for (let i = 0; i < 11; i++) {
    const response = await auth.handler(new Request(`${env.APP_URL}/api/auth/two-factor/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: env.APP_URL },
      body: JSON.stringify({ code: "000000" }),
    }));
    if (i < 10) expect(response.status).not.toBe(429);
    else expect(response.status).toBe(429);
  }
});
