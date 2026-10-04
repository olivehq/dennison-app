import { z } from "zod";

const DEV_SECRET_PLACEHOLDER = "dev-only-secret-change-me-before-deploying-0000";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: optionalUrl,
  // Where PGlite and local uploads live when DATABASE_URL and Blob are unset.
  LOCAL_DATA_DIR: z.preprocess(emptyToUndefined, z.string().default(".data")),
  APP_URL: z.preprocess(emptyToUndefined, z.url().default("http://localhost:3000")),
  BETTER_AUTH_SECRET: optionalString,
  TOKEN_PEPPER: optionalString,
  BLOB_READ_WRITE_TOKEN: optionalString,
  RESEND_API_KEY: optionalString,
  RESEND_WEBHOOK_SECRET: optionalString,
  EMAIL_FROM: z.preprocess(
    emptyToUndefined,
    z.string().default("AW Appointment Show <schedule@example.com>"),
  ),
  CRON_SECRET: optionalString,
  SENTRY_DSN: optionalString,
  NEXT_PUBLIC_SENTRY_DSN: optionalString,
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid environment variables:\n${lines.join("\n")}`);
}
const raw = parsed.data;

/**
 * Secrets fall back to a fixed dev value outside production. In production a
 * missing secret throws on first use rather than at import, so `next build`
 * can compile without secrets present.
 */
function requiredInProduction(name: "BETTER_AUTH_SECRET" | "TOKEN_PEPPER"): string {
  const value = raw[name];
  if (value) return value;
  if (raw.NODE_ENV === "production") {
    throw new Error(`${name} must be set in production`);
  }
  return `${DEV_SECRET_PLACEHOLDER}-${name.toLowerCase()}`;
}

export const env = {
  ...raw,
  get BETTER_AUTH_SECRET(): string {
    return requiredInProduction("BETTER_AUTH_SECRET");
  },
  get TOKEN_PEPPER(): string {
    return requiredInProduction("TOKEN_PEPPER");
  },
  get isProduction(): boolean {
    return raw.NODE_ENV === "production";
  },
};

export type Env = typeof env;
