import { describe, expect, it } from "vitest";
import { linksBlockedReason } from "./lock-reason";

describe("linksBlockedReason", () => {
  it("blocks link actions only on archived events", () => {
    expect(linksBlockedReason({ status: "archived" })).toMatch(/archived/);
    for (const status of ["draft", "imported", "matched", "locked", "sent"] as const) {
      expect(linksBlockedReason({ status }), status).toBeNull();
    }
  });
});
