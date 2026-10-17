import { describe, expect, it } from "vitest";
import { EVENT_SECTION_GROUPS, EVENT_SECTIONS, eventSectionHref, sectionForPath } from "./event-sections";

const ID = "6f1c2a8e-0000-4000-8000-000000000001";

describe("EVENT_SECTION_GROUPS", () => {
  it("lists every section once, Overview first", () => {
    const segments = EVENT_SECTIONS.map((s) => s.segment);
    expect(segments[0]).toBe("");
    expect(new Set(segments).size).toBe(segments.length);
    expect(EVENT_SECTION_GROUPS.map((g) => g.label)).toEqual([null, "Prepare", "Schedule", "Deliver", "Event"]);
  });
});

describe("eventSectionHref", () => {
  it("builds the overview and section paths", () => {
    expect(eventSectionHref(ID, "")).toBe(`/events/${ID}`);
    expect(eventSectionHref(ID, "schedule")).toBe(`/events/${ID}/schedule`);
  });
});

describe("sectionForPath", () => {
  it("finds the overview and each section", () => {
    expect(sectionForPath(`/events/${ID}`, ID)).toEqual({ segment: "", label: "Overview", nested: false });
    expect(sectionForPath(`/events/${ID}/`, ID)).toEqual({ segment: "", label: "Overview", nested: false });
    expect(sectionForPath(`/events/${ID}/schedule`, ID)).toEqual({ segment: "schedule", label: "Schedule", nested: false });
  });

  it("marks pages below a section as nested", () => {
    expect(sectionForPath(`/events/${ID}/imports/abc`, ID)).toEqual({ segment: "imports", label: "Imports", nested: true });
  });

  it("returns null outside the event or for an unknown segment", () => {
    expect(sectionForPath("/events", ID)).toBeNull();
    expect(sectionForPath("/team", ID)).toBeNull();
    expect(sectionForPath(`/events/${ID}x/schedule`, ID)).toBeNull();
    expect(sectionForPath(`/events/other/schedule`, ID)).toBeNull();
    expect(sectionForPath(`/events/${ID}/nope`, ID)).toBeNull();
  });
});
