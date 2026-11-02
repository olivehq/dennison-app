import { describe, expect, it } from "vitest";
import { FORM_TABS, parseSettingsTab, SETTINGS_TABS, tabForField } from "./settings-tab";

describe("parseSettingsTab", () => {
  it("accepts every tab value", () => {
    for (const tab of SETTINGS_TABS) expect(parseSettingsTab(tab.value)).toBe(tab.value);
  });

  it("falls back to the first tab for a missing or unknown value", () => {
    expect(parseSettingsTab(undefined)).toBe("event");
    expect(parseSettingsTab("nope")).toBe("event");
    expect(parseSettingsTab([])).toBe("event");
  });

  it("reads the first of repeated values", () => {
    expect(parseSettingsTab(["data", "matching"])).toBe("data");
  });
});

describe("tabForField", () => {
  it("sends targets and thresholds to Matching", () => {
    for (const field of ["supplierTarget", "buyerMin", "buyerIdeal", "buyerMax", "mutualTopN", "hotelRankCutoff", "biztechOptInRule"]) {
      expect(tabForField(field)).toBe("matching");
    }
  });

  it("sends event details and slots to Event and slots", () => {
    for (const field of ["name", "eventDate", "timezone", "rebuild-count", "slotCount", "slot-3-start", "startMinutes"]) {
      expect(tabForField(field)).toBe("event");
    }
  });

  it("keeps the form tabs a subset of the tabs", () => {
    for (const tab of FORM_TABS) expect(SETTINGS_TABS.some((t) => t.value === tab)).toBe(true);
  });
});
