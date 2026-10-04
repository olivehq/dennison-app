import { describe, expect, it } from "vitest";
import { defaultEventSettings, eventSchema, eventSettingsSchema, participantSchema, passwordSchema, supplierSchema } from ".";

describe("eventSettingsSchema", () => {
  it("accepts the defaults", () => {
    expect(eventSettingsSchema.safeParse(defaultEventSettings).success).toBe(true);
  });

  it("requires slots to match slotCount and stay in order", () => {
    const tooFew = { ...defaultEventSettings, slots: defaultEventSettings.slots.slice(0, 8) };
    const result = eventSettingsSchema.safeParse(tooFew);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("slots");
    }

    const overlapping = {
      ...defaultEventSettings,
      slots: defaultEventSettings.slots.map((s, i) => (i === 1 ? { ...s, startMinutes: 915 } : s)),
    };
    expect(eventSettingsSchema.safeParse(overlapping).success).toBe(false);
  });

  it("keeps buyer thresholds consistent", () => {
    expect(eventSettingsSchema.safeParse({ ...defaultEventSettings, buyerMin: 10 }).success).toBe(false);
    expect(eventSettingsSchema.safeParse({ ...defaultEventSettings, buyerIdeal: 6 }).success).toBe(false);
    expect(eventSettingsSchema.safeParse({ ...defaultEventSettings, supplierTarget: 12 }).success).toBe(false);
    expect(eventSettingsSchema.safeParse({ ...defaultEventSettings, slotCount: 21 }).success).toBe(false);
  });
});

describe("eventSchema", () => {
  it("validates the timezone against the IANA list", () => {
    const base = { name: "AW 2026", eventDate: "2026-11-10" };
    expect(eventSchema.safeParse({ ...base, timezone: "America/Los_Angeles" }).success).toBe(true);
    expect(eventSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...base, timezone: "UTC", eventDate: "10/11/2026" }).success).toBe(false);
  });
});

describe("roster schemas", () => {
  it("normalises emails and blanks", () => {
    const result = participantSchema.parse({
      email: "  Jane@Example.COM ",
      firstName: "Jane",
      lastName: "Doe",
      organization: "",
    });
    expect(result.email).toBe("jane@example.com");
    expect(result.organization).toBeNull();
    expect(result.biztechOptIn).toBe(false);
  });

  it("accepts a supplier with contacts", () => {
    const result = supplierSchema.safeParse({
      name: "eShow",
      type: "business",
      adminContact: { name: "Sam", email: "sam@eshow.com" },
    });
    expect(result.success).toBe(true);
    expect(supplierSchema.safeParse({ name: "X", type: "venue" }).success).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("needs at least 10 characters", () => {
    expect(passwordSchema.safeParse("short1234").success).toBe(false);
    expect(passwordSchema.safeParse("long-enough-1").success).toBe(true);
  });
});
