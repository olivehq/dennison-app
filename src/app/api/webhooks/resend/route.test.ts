import { describe, expect, it } from "vitest";
import { POST } from "./route";

function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      throw new Error("the body must not be read");
    },
  });
}

describe("POST /api/webhooks/resend", () => {
  it("refuses an oversized or unsized body with 413 before reading it", async () => {
    for (const headers of [{ "content-length": String(1024 * 1024) }, {} as Record<string, string>]) {
      const request = new Request("http://localhost/api/webhooks/resend", {
        method: "POST",
        headers,
        body: unreadableBody(),
        duplex: "half",
      } as RequestInit);
      const response = await POST(request);
      expect(response.status).toBe(413);
    }
  });
});
