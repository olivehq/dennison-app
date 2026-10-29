import { describe, expect, it } from "vitest";
import { productionEnvProblems } from "./env";

const complete = {
  NODE_ENV: "production" as const,
  DATABASE_URL: "postgres://user:pass@db.example.com/aw",
  LOCAL_DATA_DIR: ".data",
  APP_URL: "https://aw.dennison.ca",
  BETTER_AUTH_SECRET: "6YsJtQ42z9iMswFeAcLu3XvBW0dD7rHG",
  TOKEN_PEPPER: "t4H6S09WBlXx7M8cnYajKvPGdIU32Qme",
  BLOB_READ_WRITE_TOKEN: "blob",
  RESEND_API_KEY: undefined,
  RESEND_WEBHOOK_SECRET: undefined,
  EMAIL_FROM: "AW <schedule@example.com>",
  CRON_SECRET: "Qp30Xds4zJ68u2FHYmwkR7GntV9bAWec",
  SENTRY_DSN: undefined,
  NEXT_PUBLIC_SENTRY_DSN: undefined,
};

describe("productionEnvProblems", () => {
  it("accepts a complete production environment without RESEND_API_KEY", () => {
    expect(productionEnvProblems(complete)).toEqual([]);
  });

  it("names every missing variable and a localhost APP_URL", () => {
    const problems = productionEnvProblems({
      ...complete,
      DATABASE_URL: undefined,
      APP_URL: "http://localhost:3000",
      BLOB_READ_WRITE_TOKEN: undefined,
      BETTER_AUTH_SECRET: undefined,
      TOKEN_PEPPER: undefined,
      CRON_SECRET: undefined,
    });
    expect(problems.join(" ")).toMatch(/DATABASE_URL.*APP_URL.*BLOB_READ_WRITE_TOKEN.*BETTER_AUTH_SECRET.*TOKEN_PEPPER.*CRON_SECRET/);
    expect(problems).toHaveLength(6);
  });

  it("needs CRON_SECRET so the retention cron can run", () => {
    expect(productionEnvProblems({ ...complete, CRON_SECRET: undefined })).toEqual([
      "CRON_SECRET must be set to a random secret of at least 32 characters in production. Generate one with openssl rand -base64 32.",
    ]);
  });

  it("requires email credentials on Vercel production, but not previews", () => {
    expect(productionEnvProblems({ ...complete, VERCEL_ENV: "preview" })).toEqual([]);
    expect(productionEnvProblems({ ...complete, VERCEL_ENV: "production" }).join(" "))
      .toMatch(/RESEND_API_KEY.*RESEND_WEBHOOK_SECRET/);
    const email = { RESEND_API_KEY: "re_key", RESEND_WEBHOOK_SECRET: "whsec_key" };
    // Resend refuses example.com, so invites and resets would never arrive.
    expect(productionEnvProblems({ ...complete, ...email, VERCEL_ENV: "production" }).join(" ")).toContain("EMAIL_FROM must be");
    expect(
      productionEnvProblems({ ...complete, ...email, VERCEL_ENV: "production", EMAIL_FROM: "AW appointment matching <schedule@dennison.ca>" }),
    ).toEqual([]);
  });

  it.each(["http://aw.dennison.ca", "https://localhost:3000", "https://aw.localhost", "https://example.com", "https://aw.example.org", "https://example.net.", "https://127.0.0.1", "https://[::1]"])("rejects unsafe APP_URL %s", (APP_URL) => {
    expect(productionEnvProblems({ ...complete, APP_URL }).join(" ")).toContain("APP_URL must be");
  });

  it.each(["BETTER_AUTH_SECRET", "TOKEN_PEPPER", "CRON_SECRET"] as const)("rejects weak %s", (name) => {
    for (const value of ["short", "change-me-before-deploying-00000000000", "your-secret-goes-here-00000000000000", "x".repeat(40), "replace-with-a-random-secret-at-least-32-characters", "change-this-secret-before-production-00000", "your-better-auth-secret-goes-here-00000"]) {
      expect(productionEnvProblems({ ...complete, [name]: value }).join(" ")).toContain(`${name} must be set to a random secret`);
    }
  });

  it.each(["development", "test"] as const)("leaves %s unchanged", (NODE_ENV) => {
    expect(productionEnvProblems({ ...complete, NODE_ENV, VERCEL_ENV: "production", APP_URL: "http://localhost:3000", CRON_SECRET: "short" })).toEqual([]);
  });
});
