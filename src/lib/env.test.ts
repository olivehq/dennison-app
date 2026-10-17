import { describe, expect, it } from "vitest";
import { productionEnvProblems } from "./env";

const complete = {
  NODE_ENV: "production" as const,
  DATABASE_URL: "postgres://user:pass@db.example.com/aw",
  LOCAL_DATA_DIR: ".data",
  APP_URL: "https://aw.example.com",
  BETTER_AUTH_SECRET: "secret",
  TOKEN_PEPPER: "pepper",
  BLOB_READ_WRITE_TOKEN: "blob",
  RESEND_API_KEY: undefined,
  RESEND_WEBHOOK_SECRET: undefined,
  EMAIL_FROM: "AW <schedule@example.com>",
  CRON_SECRET: "cron",
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
      "CRON_SECRET must be set in production, or the retention cron can't run.",
    ]);
  });
});
