export const SETTINGS_TABS = [
  { value: "event", label: "Event and slots" },
  { value: "matching", label: "Matching" },
  { value: "schedule-page", label: "Schedule page" },
  { value: "data", label: "Participant data" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

/** The tabs that belong to the one settings form and its Save button. The others save themselves. */
export const FORM_TABS: readonly SettingsTab[] = ["event", "matching"];

/** `?tab=` from the URL, falling back to the first tab for a missing or unknown value. */
export function parseSettingsTab(value: string | string[] | undefined): SettingsTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return SETTINGS_TABS.find((tab) => tab.value === raw)?.value ?? SETTINGS_TABS[0].value;
}

const MATCHING_FIELDS = new Set([
  "supplierTarget",
  "buyerMin",
  "buyerIdeal",
  "buyerMax",
  "mutualTopN",
  "hotelRankCutoff",
  "biztechOptInRule",
]);

/** Which tab holds a form field, from its input id or the last part of its form path. */
export function tabForField(field: string): SettingsTab {
  return MATCHING_FIELDS.has(field) ? "matching" : "event";
}
