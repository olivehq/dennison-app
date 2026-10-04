import { describe, expect, it } from "vitest";
import { clientAddress, SlidingWindowLimiter } from "./rate-limit";

const TEN_MINUTES = 10 * 60 * 1000;

describe("SlidingWindowLimiter", () => {
  it("allows 60 requests in 10 minutes and refuses the 61st with a retry time", () => {
    const limiter = new SlidingWindowLimiter(60, TEN_MINUTES);
    const start = 1_000_000;
    for (let i = 0; i < 60; i++) expect(limiter.hit("1.2.3.4", start + i * 1000).allowed).toBe(true);
    const refused = limiter.hit("1.2.3.4", start + 60_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 540 });
    // Another address has its own window.
    expect(limiter.hit("5.6.7.8", start + 60_000).allowed).toBe(true);
  });

  it("slides: a request frees up when the oldest one leaves the window", () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("a", 500).allowed).toBe(true);
    expect(limiter.hit("a", 999).allowed).toBe(false);
    expect(limiter.hit("a", 1001).allowed).toBe(true);
    expect(limiter.hit("a", 1200).allowed).toBe(false);
  });

  it("prunes idle keys and caps how many it tracks", () => {
    const limiter = new SlidingWindowLimiter(5, 1000, 3);
    limiter.hit("a", 0);
    limiter.hit("b", 10);
    limiter.hit("c", 20);
    limiter.hit("d", 30);
    expect(limiter.size).toBe(3);
    limiter.hit("e", 5000);
    expect(limiter.size).toBe(1);
  });
});

describe("clientAddress", () => {
  it("prefers x-real-ip, then the first x-forwarded-for entry", () => {
    expect(clientAddress(new Headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" }))).toBe("9.9.9.9");
    expect(clientAddress(new Headers({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }))).toBe("1.1.1.1");
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});
