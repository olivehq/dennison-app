import { describe, expect, it } from "vitest";
import { eventStatusEnum } from "@/db/schema";
import { eventAllows } from "./event-gates";

const statuses = eventStatusEnum.enumValues;
const allowed = (gate: Parameters<typeof eventAllows>[0]) => statuses.filter((s) => eventAllows(gate, s));

describe("event gates (AGENTS.md invariants)", () => {
  it("locked, sent, and archived events refuse edits", () => {
    expect(allowed("edit")).toEqual(["draft", "imported", "matched"]);
  });

  it("sends and unlock need a locked or sent event", () => {
    expect(allowed("locked")).toEqual(["locked", "sent"]);
  });

  it("an archived event passes no gate", () => {
    expect(allowed("unarchived")).toEqual(statuses.filter((s) => s !== "archived"));
    for (const gate of ["edit", "locked", "unarchived", "draft"] as const) expect(eventAllows(gate, "archived")).toBe(false);
  });
});
