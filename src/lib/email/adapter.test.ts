import { beforeEach, describe, expect, it } from "vitest";
import { clearLoggedEmails, getLoggedEmails, sendBatch, sendEmail } from "./adapter";

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
    const ids = await sendBatch(messages);
    expect(ids).toHaveLength(3);
    expect(getLoggedEmails().map((m) => m.subject)).toEqual(["a", "b", "c"]);
    expect(await sendBatch([])).toEqual([]);
  });
});
