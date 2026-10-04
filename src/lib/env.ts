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

type ParsedEnv = z.infer<typeof envSchema>;

/**
 * What a production deployment is missing. Production needs a real database,
 * its public URL, Blob storage, and both secrets; RESEND_API_KEY stays
 * optional (previews may not send mail, and `sendCampaign` refuses instead).
 */
export function productionEnvProblems(values: ParsedEnv): string[] {
  const problems: string[] = [];
  if (!values.DATABASE_URL) problems.push("DATABASE_URL must be set in production.");
  if (values.APP_URL.startsWith("http://localhost")) {
    problems.push("APP_URL must be the public URL of this deployment, not http://localhost.");
  }
  if (!values.BLOB_READ_WRITE_TOKEN) problems.push("BLOB_READ_WRITE_TOKEN must be set in production.");
  if (!values.BETTER_AUTH_SECRET) problems.push("BETTER_AUTH_SECRET must be set in production.");
  if (!values.TOKEN_PEPPER) problems.push("TOKEN_PEPPER must be set in production.");
  return problems;
}

// Fail fast when a production server starts without what it needs. `next
// build` also runs with NODE_ENV=production but sets NEXT_PHASE, and must
// compile without secrets present; the browser bundle never has them either.
const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
if (raw.NODE_ENV === "production" && !isProductionBuild && typeof window === "undefined") {
  const problems = productionEnvProblems(raw);
  if (problems.length > 0) {
    throw new Error(`Invalid production environment:\n${problems.join("\n")}`);
  }
}

/**
 * Secrets fall back to a fixed dev value outside production. In production a
 * running server already refused to start without them (above); during `next
 * build` a missing secret throws on first use rather than at import.
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
