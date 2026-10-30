import { z } from "zod";
import { isExampleAddress } from "@/lib/email/example-address";

const DEV_SECRET_PLACEHOLDER = "dev-only-secret-change-me-before-deploying-0000";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL_ENV: optionalString,
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
    z.string().default("AW appointment matching <schedule@example.com>"),
  ),
  SUPPORT_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
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

/** Runtime production requirements. Vercel previews may omit email credentials. */
export function productionEnvProblems(values: ParsedEnv): string[] {
  if (values.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (!values.DATABASE_URL) problems.push("DATABASE_URL must be set in production.");
  const url = new URL(values.APP_URL);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || !host.includes(".") ||
      /(^|\.)(localhost|example\.(com|org|net))$/.test(host) ||
      host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]") {
    problems.push("APP_URL must be an https URL with this deployment's real public host, not localhost or an example.com/org/net placeholder.");
  }
  if (!values.BLOB_READ_WRITE_TOKEN) problems.push("BLOB_READ_WRITE_TOKEN must be set in production.");
  for (const name of ["BETTER_AUTH_SECRET", "TOKEN_PEPPER", "CRON_SECRET"] as const) {
    const value = values[name];
    if (!value || value.trim().length < 32 ||
        /change[-_ ]?(me|this)|placeholder|dev[-_ ](only|secret)|your[-_ ]|example|replace[-_ ]?(me|this|with)|^(secret|password|test)[-_ ]/i.test(value) || /^(.)\1+$/.test(value.trim())) {
      problems.push(`${name} must be set to a random secret of at least 32 characters in production. Generate one with openssl rand -base64 32.`);
    }
  }
  if (values.VERCEL_ENV === "production") {
    for (const name of ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"] as const) {
      if (!values[name]?.trim()) problems.push(`${name} must be set for Vercel production. Set the Resend ${name === "RESEND_API_KEY" ? "API key with send access" : "webhook signing secret for /api/webhooks/resend"}.`);
    }
    // Invites and password resets go out from EMAIL_FROM; Resend refuses example.com.
    if (isExampleAddress(values.EMAIL_FROM)) {
      problems.push('EMAIL_FROM must be an address on your verified Resend domain for Vercel production, for example "AW appointment matching <schedule@yourdomain.com>".');
    }
  }
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
