import { describe, expect, it } from "vitest";
import { safeNextPath } from "./auth-errors";

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
