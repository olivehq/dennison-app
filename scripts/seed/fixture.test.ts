import { describe, expect, it } from "vitest";
import { loadFixture, parseFixture } from "./fixture";
import { demoBuyers, demoSupplierContacts, splitBuyerName } from "./people";

describe("parseFixture", () => {
  it("reads the 2025 results without evaluating the file", () => {
    const fixture = loadFixture();
    expect(fixture.event).toMatchObject({ name: "AW 2025 Appointment Show", date: "2025-11-14" });
    expect(fixture.buyers).toHaveLength(65);
    expect(fixture.suppliers).toHaveLength(56);
    expect(fixture.suppliers.filter((s) => s.type === "business")).toHaveLength(9);
    expect(fixture.appointments).toHaveLength(504);
  });

  it("accepts the assignment with surrounding comments and a semicolon", () => {
    const source = `// note\nwindow.AW_DATA = {"event":{"name":"X","date":"2025-01-02"},"suppliers":[{"name":"S","type":"hotel","desk":1}],"buyers":[{"name":"B"}],"appointments":[{"slot":1,"supplier":"S","buyer":"B","buyerRank":null,"supplierRank":2}]};\n`;
    const fixture = parseFixture(source);
    expect(fixture.appointments[0]).toMatchObject({ buyerRank: null, supplierRank: 2 });
  });

  it("refuses files that are not the expected shape", () => {
    expect(() => parseFixture("module.exports = {}")).toThrow(/AW_DATA/);
    expect(() => parseFixture('window.AW_DATA = {"event":{}}')).toThrow();
    const unknownBuyer = `window.AW_DATA = {"event":{"name":"X","date":"2025-01-02"},"suppliers":[{"name":"S","type":"hotel","desk":1}],"buyers":[],"appointments":[{"slot":1,"supplier":"S","buyer":"B","buyerRank":1,"supplierRank":1}]}`;
    expect(() => parseFixture(unknownBuyer)).toThrow(/unknown buyer/);
  });
});

describe("demo identities", () => {
  it("splits Org - Title at the first separator", () => {
    expect(splitBuyerName("HelmsBriscoe - AB")).toEqual({ organization: "HelmsBriscoe", title: "AB" });
    expect(splitBuyerName("CA Medical Association - Senior Director, Meetings - West")).toEqual({
      organization: "CA Medical Association",
      title: "Senior Director, Meetings - West",
    });
    expect(splitBuyerName("Solo")).toEqual({ organization: "Solo", title: null });
  });

  it("gives every 2025 buyer a unique, stable example.org email", () => {
    const fixture = loadFixture();
    const people = demoBuyers(fixture.buyers);
    expect(new Set(people.map((p) => p.email)).size).toBe(65);
    expect(people.every((p) => /^[a-z]+\.[a-z]+\d*@example\.org$/.test(p.email))).toBe(true);
    expect(demoBuyers(fixture.buyers)).toEqual(people);
    expect(people[0]).toMatchObject({
      organization: "ACWA Joint Powers Insurance Authority",
      title: "Communication & Events Specialist",
    });
  });

  it("gives supplier contacts slug addresses", () => {
    const contacts = demoSupplierContacts("Dennison & Associates");
    expect(contacts.adminContact.email).toBe("dennison-and-associates@example.com");
    expect(contacts.attendeeContact.email).toBe("attendee.dennison-and-associates@example.com");
  });
});
