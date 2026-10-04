import { createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Participant link tokens (D14): 32 random bytes, base64url in the link, a
 * peppered SHA-256 in the database. The plain token is never stored, so a
 * leaked database cannot be turned into working links.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 over `TOKEN_PEPPER + token`, hex. `pepper` is injectable for tests. */
export function hashToken(token: string, pepper: string = env.TOKEN_PEPPER): string {
  return createHash("sha256").update(pepper + token).digest("hex");
}
