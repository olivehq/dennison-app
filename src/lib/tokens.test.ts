import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, generateToken } from "./tokens";

describe("token encryption (D59)", () => {
  it("round-trips with the same pepper and uses a fresh iv each time", () => {
    const token = generateToken();
    const first = encryptToken(token, "pepper-a");
    const second = encryptToken(token, "pepper-a");
    expect(first).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
    expect(decryptToken(first, "pepper-a")).toBe(token);
    expect(decryptToken(second, "pepper-a")).toBe(token);
  });

  it("returns null for another pepper, tampering, or malformed input", () => {
    const sealed = encryptToken(generateToken(), "pepper-a");
    expect(decryptToken(sealed, "pepper-b")).toBeNull();
    const [iv, ciphertext, tag] = sealed.split(".");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] ^= 1;
    expect(decryptToken([iv, flipped.toString("base64"), tag].join("."), "pepper-a")).toBeNull();
    expect(decryptToken("not-a-ciphertext", "pepper-a")).toBeNull();
    expect(decryptToken("a.b.c", "pepper-a")).toBeNull();
  });

  it("uses TOKEN_PEPPER by default", () => {
    const token = generateToken();
    expect(decryptToken(encryptToken(token))).toBe(token);
  });
});
