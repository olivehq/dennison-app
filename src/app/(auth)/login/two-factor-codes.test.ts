import { describe, expect, it } from "vitest";
import { normalizeBackupCode, normalizeTotpCode } from "./two-factor-codes";

describe("normalizeTotpCode", () => {
  it("accepts six digits with or without spaces and dashes", () => {
    expect(normalizeTotpCode("123456")).toBe("123456");
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
    expect(normalizeTotpCode("123-456")).toBe("123456");
  });

  it("refuses anything else", () => {
    for (const value of ["", "12345", "1234567", "12345a", "abcdef"]) expect(normalizeTotpCode(value)).toBeNull();
  });
});

describe("normalizeBackupCode", () => {
  it("keeps the case and puts the dash back", () => {
    expect(normalizeBackupCode("aBcDe-12345")).toBe("aBcDe-12345");
    expect(normalizeBackupCode(" aBcDe12345 ")).toBe("aBcDe-12345");
    expect(normalizeBackupCode("aBcDe 12345")).toBe("aBcDe-12345");
  });

  it("refuses anything else", () => {
    for (const value of ["", "abcde-1234", "abcde_12345", "abcde-12345-x", "123456"]) {
      expect(normalizeBackupCode(value)).toBeNull();
    }
  });
});
