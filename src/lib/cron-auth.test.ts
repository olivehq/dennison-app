import { describe, expect, it } from "vitest";
import { rejectCronRequest } from "./cron-auth";

describe("rejectCronRequest", () => {
  it("is shut with 503 when no secret is configured", async () => {
    const response = rejectCronRequest("Bearer anything", undefined);
    expect(response?.status).toBe(503);
    expect(rejectCronRequest(null, "")?.status).toBe(503);
  });

  it("refuses a missing or wrong bearer token with 401", () => {
    expect(rejectCronRequest(null, "s3cret")?.status).toBe(401);
    expect(rejectCronRequest("Bearer wrong", "s3cret")?.status).toBe(401);
    expect(rejectCronRequest("s3cret", "s3cret")?.status).toBe(401);
    expect(rejectCronRequest("Bearer s3cret ", "s3cret")?.status).toBe(401);
  });

  it("lets the right bearer token through", () => {
    expect(rejectCronRequest("Bearer s3cret", "s3cret")).toBeNull();
  });
});
