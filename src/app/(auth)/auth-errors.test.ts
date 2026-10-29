import { describe, expect, it } from "vitest";
import {
  classifyAuthError,
  describeAuthError,
  formatCountdown,
  parseRetryAfter,
  safeNextPath,
  secondsUntil,
  waitCopy,
} from "./auth-errors";

describe("safeNextPath", () => {
  it("keeps a same-site path with its query and hash", () => {
    expect(safeNextPath("/events/x?compare=y")).toBe("/events/x?compare=y");
    expect(safeNextPath("/events/x?compare=y#run")).toBe("/events/x?compare=y#run");
  });

  it("falls back when there is no usable value", () => {
    expect(safeNextPath(undefined)).toBe("/events");
    expect(safeNextPath("")).toBe("/events");
    expect(safeNextPath("events")).toBe("/events");
    expect(safeNextPath("https://evil.com")).toBe("/events");
    expect(safeNextPath("/x", "/home")).toBe("/x");
    expect(safeNextPath(undefined, "/home")).toBe("/home");
  });

  it("falls back for a repeated next param instead of throwing", () => {
    expect(safeNextPath(["/events/a", "/events/b"])).toBe("/events");
  });

  it("refuses paths that a browser would resolve to another site", () => {
    for (const next of [
      "//evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "/\t/evil.com",
      "/%09/evil.com",
      "/%5Cevil.com",
      "/%2F/evil.com",
      "/\n/evil.com",
      "/.//evil.com",
      "/a/..//evil.com",
      "/%E0%A4%A",
    ]) {
      expect(safeNextPath(next), next).toBe("/events");
    }
  });
});

describe("parseRetryAfter", () => {
  it("reads whole seconds", () => {
    expect(parseRetryAfter("540")).toBe(540);
    expect(parseRetryAfter(" 60 ")).toBe(60);
  });

  it("ignores a missing, zero, or malformed value", () => {
    for (const value of [null, undefined, "", "0", "-5", "1.5", "soon", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      expect(parseRetryAfter(value), String(value)).toBeNull();
    }
  });
});

describe("classifyAuthError", () => {
  const now = 1_000_000;
  const error = (status: number, code?: string, message?: string) => ({ status, statusText: "", code, message });

  it("turns a 429 into a retry time from the header", () => {
    expect(classifyAuthError(error(429), "x", 90, now)).toEqual({ kind: "rate-limited", retryAt: now + 90_000 });
    expect(classifyAuthError(error(429), "x", null, now)).toEqual({ kind: "rate-limited", retryAt: null });
  });

  it("groups the wrong-credentials codes", () => {
    for (const code of ["INVALID_EMAIL_OR_PASSWORD", "INVALID_PASSWORD", "USER_NOT_FOUND"]) {
      expect(classifyAuthError(error(401, code), "x", null, now)).toEqual({ kind: "invalid-credentials" });
    }
  });

  it("keeps the server message for anything else, such as a disabled account", () => {
    expect(classifyAuthError(error(403, "ACCOUNT_DISABLED", "This account is disabled."), "x", null, now)).toEqual({
      kind: "error",
      message: "This account is disabled.",
    });
    expect(classifyAuthError(error(500), "Try again.", null, now)).toEqual({ kind: "error", message: "Try again." });
    expect(classifyAuthError(error(400, "INVALID_TOKEN"), "x", null, now)).toEqual({
      kind: "error",
      message: describeAuthError(error(400, "INVALID_TOKEN"), "x"),
    });
  });
});

describe("rate-limit countdown", () => {
  it("counts whole seconds down to zero", () => {
    expect(secondsUntil(10_000, 0)).toBe(10);
    expect(secondsUntil(10_000, 9_001)).toBe(1);
    expect(secondsUntil(10_000, 10_000)).toBe(0);
    expect(secondsUntil(10_000, 20_000)).toBe(0);
  });

  it("formats minutes and padded seconds", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(600)).toBe("10:00");
  });

  it("rounds the wait sentence up to whole minutes", () => {
    expect(waitCopy(1)).toBe("Wait 1 minute, then try again.");
    expect(waitCopy(60)).toBe("Wait 1 minute, then try again.");
    expect(waitCopy(61)).toBe("Wait 2 minutes, then try again.");
    expect(waitCopy(null)).toBe("Wait 10 minutes, then try again.");
  });
});
