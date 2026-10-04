import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Participant link tokens (D14): 32 random bytes, base64url in the link, a
 * peppered SHA-256 in the database for lookups. The plain token is stored
 * only encrypted under a key derived from the pepper (D59), so a leaked
 * database without the pepper cannot be turned into working links.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 over `TOKEN_PEPPER + token`, hex. `pepper` is injectable for tests. */
export function hashToken(token: string, pepper: string = env.TOKEN_PEPPER): string {
  return createHash("sha256").update(pepper + token).digest("hex");
}

const CIPHER = "aes-256-gcm";
const KEY_INFO = "aw-access-token-ciphertext-v1";

function tokenKey(pepper: string): Buffer {
  return Buffer.from(hkdfSync("sha256", pepper, "", KEY_INFO, 32));
}

/**
 * The plain token encrypted with AES-256-GCM under a key derived from
 * `TOKEN_PEPPER` (D59), as base64 `iv.ciphertext.tag`. Stored beside the hash
 * so a link can be reused in a later email instead of rotated.
 */
export function encryptToken(token: string, pepper: string = env.TOKEN_PEPPER): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, tokenKey(pepper), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, ciphertext, tag].map((part) => part.toString("base64")).join(".");
}

/** The plain token, or null when the value is malformed, tampered with, or from another pepper. */
export function decryptToken(value: string, pepper: string = env.TOKEN_PEPPER): string | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [iv, ciphertext, tag] = parts.map((part) => Buffer.from(part, "base64"));
  if (iv.length !== 12 || tag.length !== 16) return null;
  try {
    const decipher = createDecipheriv(CIPHER, tokenKey(pepper), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
