import { describe, expect, it } from "vitest";
import { buildCsp, createNonce } from "./csp";

describe("buildCsp", () => {
  it("locks scripts to the nonce in production and allows the Sentry ingest host", () => {
    const csp = buildCsp({ nonce: "abc", isDev: false, sentryDsn: "https://key@o1.ingest.us.sentry.io/42" });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self' https://o1.ingest.us.sentry.io;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("adds 'unsafe-eval' only in development and ignores a malformed DSN", () => {
    const csp = buildCsp({ nonce: "abc", isDev: true, sentryDsn: "not a url" });
    expect(csp).toContain("'strict-dynamic' 'unsafe-eval'");
    expect(csp).toContain("connect-src 'self';");
  });
});

describe("createNonce", () => {
  it("is base64 and differs every call", () => {
    const nonce = createNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(nonce);
  });
});
