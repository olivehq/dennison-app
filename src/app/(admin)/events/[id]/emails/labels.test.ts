import { describe, expect, it } from "vitest";
import { EMAIL_AUDIENCES } from "@/lib/schemas/email";
import type { EmailSetup } from "@/server/email/campaigns";
import { audiencePhrase, emailSetupReason } from "./labels";

describe("audiencePhrase", () => {
  it("reads as the end of 'Update email to ...' for every audience", () => {
    expect(audiencePhrase("changed_since_last_send")).toBe("people whose schedule changed since their last email");
    expect(audiencePhrase("buyers")).toBe("buyers");
    expect(audiencePhrase("selected")).toBe("selected people");
    for (const audience of EMAIL_AUDIENCES) expect(audiencePhrase(audience)).not.toMatch(/^changed since/);
  });
});

describe("emailSetupReason", () => {
  const production: EmailSetup = { configured: true, refuseExampleSender: true, senderDomain: "myassociationswest.org" };

  it("lets a From email on the sending domain through", () => {
    expect(emailSetupReason(production, "info@myassociationswest.org")).toBeNull();
  });

  it("says to use the sending domain when the From email is elsewhere", () => {
    expect(emailSetupReason(production, "laura@gmail.com")).toBe(
      "The From email isn't on myassociationswest.org. Change it to an address on myassociationswest.org.",
    );
    expect(emailSetupReason(production, "laura@gmail.com", { retry: true })).toContain("Duplicate it");
  });

  it("keeps the example.com reason first, and doesn't block development or a deployment with no sending domain", () => {
    expect(emailSetupReason(production, "schedule@example.com")).toContain("example.com");
    expect(emailSetupReason({ ...production, refuseExampleSender: false }, "laura@gmail.com")).toBeNull();
    expect(emailSetupReason({ ...production, senderDomain: null }, "laura@gmail.com")).toBeNull();
  });
});
