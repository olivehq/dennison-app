import { describe, expect, it } from "vitest";
import { EMAIL_AUDIENCES } from "@/lib/schemas/email";
import { audiencePhrase } from "./labels";

describe("audiencePhrase", () => {
  it("reads as the end of 'Update email to ...' for every audience", () => {
    expect(audiencePhrase("changed_since_last_send")).toBe("people whose schedule changed since their last email");
    expect(audiencePhrase("buyers")).toBe("buyers");
    expect(audiencePhrase("selected")).toBe("selected people");
    for (const audience of EMAIL_AUDIENCES) expect(audiencePhrase(audience)).not.toMatch(/^changed since/);
  });
});
