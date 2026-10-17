import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

describe("proxy", () => {
  it("sends a signed-out request to login with the full path and query as next", () => {
    const response = proxy(new NextRequest("http://localhost:3000/events/x/matching?compare=y"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/events/x/matching?compare=y");
  });

  it("forwards the path and query to pages for requireSession, replacing any value the client sent", () => {
    const request = new NextRequest("http://localhost:3000/events/x/participants?q=ann", {
      headers: { cookie: "better-auth.session_token=abc", "x-next-path": "//evil.com" },
    });
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-request-x-next-path")).toBe("/events/x/participants?q=ann");
  });
});
