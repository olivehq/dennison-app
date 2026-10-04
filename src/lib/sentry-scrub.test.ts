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
