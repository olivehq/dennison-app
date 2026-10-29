import { describe, expect, it } from "vitest";
import { backupCodesText, describeTwoFactorError, groupSecret, qrPath, secretFromTotpUri } from "./two-factor-setup";

const URI = "otpauth://totp/AW%20appointment%20matching:dana%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AW%20appointment%20matching&digits=6&period=30";

describe("two-factor setup helpers", () => {
  it("reads the secret from the URI and groups it by four", () => {
    expect(secretFromTotpUri(URI)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(secretFromTotpUri("not a uri")).toBeNull();
    expect(groupSecret("JBSWY3DPEHPK3PXPJB")).toBe("JBSW Y3DP EHPK 3PXP JB");
  });

  it("draws a square QR code with a quiet border", () => {
    const { size, path } = qrPath(URI);
    expect(size).toBeGreaterThan(21);
    expect(path).toMatch(/^M\d+ \d+h1v1h-1z/);
    // The border rows stay empty.
    expect(path).not.toMatch(/M\d+ 0h/);
  });

  it("writes the codes one per line under the account", () => {
    const text = backupCodesText(["aaaaa-11111", "bbbbb-22222"], "dana@example.com");
    expect(text).toContain("dana@example.com");
    expect(text).toContain("\naaaaa-11111\nbbbbb-22222\n");
  });

  it("says what went wrong in plain words", () => {
    expect(describeTwoFactorError({ code: "INVALID_PASSWORD", status: 400 })).toBe(
      "That isn't your password. Check it and try again.",
    );
    expect(describeTwoFactorError({ status: 429 })).toMatch(/Too many tries/);
    expect(describeTwoFactorError({ status: 401 })).toMatch(/session ended/);
  });
});
