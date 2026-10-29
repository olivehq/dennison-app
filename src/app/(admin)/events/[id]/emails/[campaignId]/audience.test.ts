import { describe, expect, it } from "vitest";
import type { AudienceOption } from "@/server/email/queries";
import { audienceMembers, sendPlan, skippedNote } from "./audience";

function contact(key: string, over: Partial<AudienceOption> = {}): AudienceOption {
  return { key, contactType: "buyer", name: key, email: `${key}@x.test`, changed: false, linkRevoked: false, ...over };
}

const contacts = [
  contact("a", { changed: true }),
  contact("b", { linkRevoked: true }),
  contact("c", { contactType: "supplier_admin", changed: true }),
  contact("d", { contactType: "supplier_attendee" }),
];

describe("audienceMembers", () => {
  it("lists only the people each audience covers", () => {
    const keys = (audience: Parameters<typeof audienceMembers>[1], selected: string[] = []) =>
      audienceMembers(contacts, audience, selected).map((c) => c.key);
    expect(keys("all")).toEqual(["a", "b", "c", "d"]);
    expect(keys("buyers")).toEqual(["a", "b"]);
    expect(keys("suppliers")).toEqual(["c", "d"]);
    expect(keys("changed_since_last_send")).toEqual(["a", "c"]);
    expect(keys("selected", ["d", "a", "gone"])).toEqual(["a", "d"]);
    expect(keys("selected")).toEqual([]);
  });
});

describe("sendPlan", () => {
  it("counts only who will be sent and names who is left out", () => {
    const plan = sendPlan(audienceMembers(contacts, "all", []));
    expect(plan.sendCount).toBe(3);
    expect(plan.skipped.map((c) => c.key)).toEqual(["b"]);
    expect(sendPlan([]).sendCount).toBe(0);
  });
});

describe("skippedNote", () => {
  it("is null when nobody is skipped and names a few people otherwise", () => {
    expect(skippedNote([])).toBeNull();
    expect(skippedNote([{ name: "Ann" }])).toBe(
      "Ann will be left out: their link was revoked. Use Regenerate on the roster to give them a new link.",
    );
    expect(skippedNote([{ name: "Ann" }, { name: "Bo" }])).toContain("Ann and Bo will be left out: their links were revoked.");
    expect(skippedNote(["A", "B", "C", "D", "E"].map((name) => ({ name })))).toContain("A, B, C, and 2 more will be left out");
  });
});
