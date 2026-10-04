import { describe, expect, it } from "vitest";
import { parseResendEvent } from "./webhook";

const bounced = {
  type: "email.bounced",
  created_at: "2026-11-02T18:04:11.000Z",
  data: {
    broadcast_id: "8b146471-e88e-4322-86af-016cd36fd216",
    created_at: "2026-11-02T18:04:10.000Z",
    email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
    from: "AW Appointment Show <schedule@example.com>",
    to: ["buyer@example.org"],
    subject: "Your appointment schedule",
    bounce: {
      message: "The recipient's mailbox does not exist.",
      subType: "General",
      type: "Permanent",
    },
    tags: { aw_message: "0b1e8e36-5a4f-4f0a-9d76-3f3b0e6b4a10" },
  },
};

describe("parseResendEvent", () => {
  it("reads a bounce with its reason and our message tag", () => {
    expect(parseResendEvent(bounced, "msg_2Kp")).toEqual({
      type: "bounced",
      providerMessageId: "56761188-7520-42d8-8898-ff6fc54ce618",
      messageId: "0b1e8e36-5a4f-4f0a-9d76-3f3b0e6b4a10",
      at: "2026-11-02T18:04:11.000Z",
      detail: "Permanent: General: The recipient's mailbox does not exist.",
      webhookId: "msg_2Kp",
    });
  });

  it("reads delivered events and tags given as a list", () => {
    const event = parseResendEvent({
      type: "email.delivered",
      created_at: "2026-11-02T18:05:00.000Z",
      data: { email_id: "abc", tags: [{ name: "aw_message", value: "not-a-uuid" }] },
    });
    expect(event).toMatchObject({ type: "delivered", providerMessageId: "abc", messageId: null });
    expect(event).not.toHaveProperty("detail");
  });

  it("ignores events that are not about a sent email, and junk", () => {
    expect(parseResendEvent({ type: "contact.created", created_at: "x", data: { email_id: "a" } })).toBeNull();
    expect(parseResendEvent({ type: "email.received", created_at: "x", data: { email_id: "a" } })).toBeNull();
    expect(parseResendEvent({ type: "email.delivered" })).toBeNull();
    expect(parseResendEvent("nope")).toBeNull();
  });
});
