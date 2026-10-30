import { describe, expect, it } from "vitest";
import { loginPathFor } from "./login-redirect";

describe("loginPathFor", () => {
  it("sends the user back to the page and its filters after sign-in", () => {
    const path = loginPathFor("/events/x/participants?q=ann&link=revoked");
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/events/x/participants?q=ann&link=revoked");
  });

  it("drops a missing, root, or unsafe path", () => {
    expect(loginPathFor(null)).toBe("/login");
    expect(loginPathFor("/")).toBe("/login");
    expect(loginPathFor("//evil.com")).toBe("/login");
    expect(loginPathFor("/\\evil.com")).toBe("/login");
    expect(loginPathFor("https://evil.com")).toBe("/login");
  });
});

it("adds the session-ended marker independently of the destination", () => {
  expect(loginPathFor(null, true)).toBe("/login?sessionEnded=1");
  expect(loginPathFor("/", true)).toBe("/login?sessionEnded=1");
  expect(loginPathFor("/events", true)).toBe("/login?next=%2Fevents&sessionEnded=1");
});
