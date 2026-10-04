import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { scrubEvent } from "./sentry-scrub";

describe("scrubEvent", () => {
  it("replaces participant tokens in the URL, transaction, and breadcrumbs", () => {
    const token = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr";
    const event = scrubEvent({
      type: undefined,
      request: { url: `https://app.example.com/s/${token}?x=1`, headers: { referer: `https://app.example.com/s/${token}` } },
      transaction: `GET /s/${token}`,
      breadcrumbs: [{ message: `navigated to /s/${token}`, data: { from: `/s/${token}`, to: "/login" } }],
    } as ErrorEvent);
    expect(JSON.stringify(event)).not.toContain(token);
    expect(event.request?.url).toBe("https://app.example.com/s/[token]?x=1");
    expect(event.transaction).toBe("GET /s/[token]");
    expect(event.breadcrumbs?.[0].data).toEqual({ from: "/s/[token]", to: "/login" });
  });
});

describe("scrubEvent covers invite and reset links and every URL-bearing field", () => {
  const participant = "UGFydGljaXBhbnRUb2tlbjEyMzQ1Njc4OTBhYmNkZWZn";
  const invite = "SW52aXRlVG9rZW4xMjM0NTY3ODkwYWJjZGVmZ2hpams";
  const reset = "ResetTok3nAbc123";

  function scrubbed(event: Partial<ErrorEvent>): ErrorEvent {
    const out = scrubEvent({ type: undefined, ...event } as ErrorEvent);
    const json = JSON.stringify(out);
    expect(json).not.toContain(participant);
    expect(json).not.toContain(invite);
    expect(json).not.toContain(reset);
    return out;
  }

  it("request url and referer", () => {
    const out = scrubbed({
      request: {
        url: `https://app.example.com/invite/${invite}`,
        headers: { referer: `https://app.example.com/reset-password?token=${reset}&x=1` },
      },
    });
    expect(out.request?.url).toBe("https://app.example.com/invite/[token]");
    expect(out.request?.headers?.referer).toBe("https://app.example.com/reset-password?token=[token]&x=1");
  });

  it("query string as a string, an object, and pairs", () => {
    expect(scrubbed({ request: { query_string: `token=${reset}&callbackURL=%2Flogin` } }).request?.query_string).toBe(
      "token=[token]&callbackURL=%2Flogin",
    );
    expect(scrubbed({ request: { query_string: { token: reset, page: "2" } } }).request?.query_string).toEqual({
      token: "[token]",
      page: "2",
    });
    expect(scrubbed({ request: { query_string: [["inviteToken", invite], ["page", "2"]] } }).request?.query_string).toEqual([
      ["inviteToken", "[token]"],
      ["page", "2"],
    ]);
  });

  it("contexts, walked recursively, including request_path", () => {
    const out = scrubbed({
      contexts: {
        nextjs: { request_path: `/s/${participant}`, route_type: "render" },
        nested: { deeper: { list: [`/invite/${invite}`, { url: `/api/auth/reset-password/${reset}?callbackURL=/reset-password` }] } },
      },
    });
    expect(out.contexts?.nextjs).toEqual({ request_path: "/s/[token]", route_type: "render" });
    expect(out.contexts?.nested).toEqual({
      deeper: { list: ["/invite/[token]", { url: "/api/auth/reset-password/[token]?callbackURL=/reset-password" }] },
    });
  });

  it("breadcrumbs, any data key", () => {
    const out = scrubbed({
      breadcrumbs: [
        { message: `GET /invite/${invite}`, data: { url: `/s/${participant}`, extra: { href: `/reset-password?token=${reset}` } } },
      ],
    });
    expect(out.breadcrumbs?.[0].message).toBe("GET /invite/[token]");
    expect(out.breadcrumbs?.[0].data).toEqual({ url: "/s/[token]", extra: { href: "/reset-password?token=[token]" } });
  });

  it("transaction names", () => {
    expect(scrubbed({ transaction: `GET /invite/${invite}` }).transaction).toBe("GET /invite/[token]");
  });

  it("exception messages, the event message, tags, and extra", () => {
    const out = scrubbed({
      message: `failed at /s/${participant}`,
      exception: { values: [{ type: "Error", value: `fetch /reset-password?token=${reset} failed for /invite/${invite}` }] },
      tags: { path: `/s/${participant}` },
      extra: { link: `https://app.example.com/invite/${invite}` },
    });
    expect(out.exception?.values?.[0].value).toBe("fetch /reset-password?token=[token] failed for /invite/[token]");
    expect(out.message).toBe("failed at /s/[token]");
    expect(out.tags).toEqual({ path: "/s/[token]" });
  });
});
