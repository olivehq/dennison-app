import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLoggedEmails,
  EmailRejectedError,
  getLoggedEmails,
  isProviderRefusal,
  recipientDomain,
  RESEND_BATCH_LIMIT,
  sendBatch,
  sendEmail,
} from "./adapter";

beforeEach(() => {
  clearLoggedEmails();
});

describe("email adapter (logger)", () => {
  it("captures single sends", async () => {
    const result = await sendEmail({
      to: "a@example.com",
      from: "AW <schedule@example.com>",
      subject: "Hi",
      html: "<p>Hi</p>",
    });
    expect(result.id).toMatch(/^logged-/);
    expect(getLoggedEmails()).toHaveLength(1);
    expect(getLoggedEmails()[0].to).toBe("a@example.com");
  });

  it("captures batches in order and returns one id per message", async () => {
    const messages = ["a", "b", "c"].map((n) => ({
      to: `${n}@example.com`,
      from: "AW <schedule@example.com>",
      subject: n,
      html: "<p></p>",
    }));
    const ids = await sendBatch(messages, { idempotencyKey: "batch-1" });
    expect(ids).toHaveLength(3);
    expect(getLoggedEmails().map((m) => m.subject)).toEqual(["a", "b", "c"]);
    expect(await sendBatch([], { idempotencyKey: "batch-2" })).toEqual([]);
  });

  it("logs a batch retried under the same idempotency key once and returns the first ids", async () => {
    const message = { to: "a@example.com", from: "AW <schedule@example.com>", subject: "a", html: "<p></p>" };
    const first = await sendBatch([message], { idempotencyKey: "batch-retried" });
    const again = await sendBatch([message], { idempotencyKey: "batch-retried" });
    expect(again).toEqual(first);
    expect(getLoggedEmails()).toHaveLength(1);
    await sendBatch([message], { idempotencyKey: "batch-new" });
    expect(getLoggedEmails()).toHaveLength(2);
  });

  it("refuses a batch over the provider limit instead of splitting it", async () => {
    const message = { to: "a@example.com", from: "AW <schedule@example.com>", subject: "a", html: "<p></p>" };
    const before = getLoggedEmails().length;
    const tooMany = sendBatch(Array.from({ length: RESEND_BATCH_LIMIT + 1 }, () => message), { idempotencyKey: "batch-big" });
    await expect(tooMany).rejects.toThrow(/at most 100/);
    await expect(tooMany).rejects.toBeInstanceOf(EmailRejectedError);
    expect(getLoggedEmails()).toHaveLength(before);
  });
});

describe("isProviderRefusal", () => {
  it("is true only for a 4xx that says the batch was not taken", () => {
    expect(isProviderRefusal({ statusCode: 422, name: "validation_error" })).toBe(true);
    // No answer, a server error, or a clash on the idempotency key: it may have been sent.
    expect(isProviderRefusal({ statusCode: null, name: "application_error" })).toBe(false);
    expect(isProviderRefusal({ statusCode: 500, name: "internal_server_error" })).toBe(false);
    // A rate limit may be checked before the key, so an earlier attempt may have gone.
    expect(isProviderRefusal({ statusCode: 429, name: "rate_limit_exceeded" })).toBe(false);
    expect(isProviderRefusal({ statusCode: 409, name: "concurrent_idempotent_requests" })).toBe(false);
    expect(isProviderRefusal({ statusCode: 409, name: "invalid_idempotent_request" })).toBe(false);
  });
});

describe("recipientDomain", () => {
  it("keeps only the domain, for logs", () => {
    expect(recipientDomain("Ann.Lee@Example.COM")).toBe("example.com");
    expect(recipientDomain("Ann <ann@example.org>")).toBe("example.org");
    expect(recipientDomain("no-at-sign")).toBe("unknown");
  });
});
