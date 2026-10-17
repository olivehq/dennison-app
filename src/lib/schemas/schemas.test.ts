import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  defaultEventSettings,
  eventSchema,
  eventSettingsSchema,
  participantSchema,
  passwordSchema,
  profileNameSchema,
  supplierSchema,
} from ".";

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

  it("asks for a date when none is picked, and for the format when it is malformed", () => {
    const message = (eventDate: string) =>
      eventSchema.safeParse({ name: "AW 2026", timezone: "America/Los_Angeles", eventDate }).error?.issues[0]?.message;
    expect(message("")).toBe("Pick a show date.");
    expect(message("10/11/2026")).toBe("Use the format YYYY-MM-DD.");
    expect(message("2026-11-10")).toBeUndefined();
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

describe("profileNameSchema", () => {
  it("trims the name and needs one", () => {
    expect(profileNameSchema.parse({ name: "  Dana Lee  " })).toEqual({ name: "Dana Lee" });
    expect(profileNameSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(profileNameSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  const valid = {
    currentPassword: "old-password-1",
    newPassword: "new-password-12",
    confirmPassword: "new-password-12",
    revokeOtherSessions: true,
  };

  it("accepts a valid change", () => {
    expect(changePasswordSchema.safeParse(valid).success).toBe(true);
  });

  it("uses the password rules, and needs the repeat to match and the password to change", () => {
    const issues = (input: object) =>
      changePasswordSchema.safeParse({ ...valid, ...input }).error?.issues.map((i) => [i.path.join("."), i.message]);
    expect(issues({ newPassword: "short", confirmPassword: "short" })).toEqual([["newPassword", "Use at least 10 characters."]]);
    expect(issues({ confirmPassword: "something-else" })).toEqual([["confirmPassword", "The two passwords don't match."]]);
    expect(issues({ newPassword: valid.currentPassword, confirmPassword: valid.currentPassword })).toEqual([
      ["newPassword", "Choose a password that's different from the current one."],
    ]);
    expect(issues({ currentPassword: "" })?.[0]).toEqual(["currentPassword", "Enter your current password."]);
  });
});
