import { describe, expect, it } from "vitest";
import { MAX_FILENAME_LENGTH, scheduleFilename, uniqueFilenames } from "./filenames";

describe("scheduleFilename", () => {
  it("applies the spec's character rules", () => {
    expect(scheduleFilename("Supplier_Schedule_", "Hilton Irvine/Orange County Airport")).toBe(
      "Supplier_Schedule_Hilton Irvine_Orange County Airport.csv",
    );
    expect(scheduleFilename("Supplier_Schedule_", "El Capitan Hotel, Merced")).toBe(
      "Supplier_Schedule_El Capitan Hotel Merced.csv",
    );
    expect(scheduleFilename("Buyer_Schedule_", "A\\B: C")).toBe("Buyer_Schedule_A_B- C.csv");
  });

  it("collapses whitespace and replaces characters Windows refuses", () => {
    expect(scheduleFilename("Buyer_Schedule_", "  MMPA  -  CEO | EVP \t")).toBe("Buyer_Schedule_MMPA - CEO _ EVP.csv");
    expect(scheduleFilename("Buyer_Schedule_", 'What? "Yes" <no>*')).toBe("Buyer_Schedule_What_ _Yes_ _no__.csv");
  });

  it("caps the name at 80 characters including .csv", () => {
    const long = "Advocacy & Management Group, Inc - Automotive Services Council of California- California Pawnbrokers Association";
    const name = scheduleFilename("Buyer_Schedule_", long);
    expect(name).toHaveLength(MAX_FILENAME_LENGTH);
    expect(name.endsWith(".csv")).toBe(true);
    expect(name.startsWith("Buyer_Schedule_Advocacy & Management Group Inc")).toBe(true);
  });

  it("does not leave a trailing space before the extension after cutting", () => {
    const name = scheduleFilename("P_", `${"x".repeat(74)} tail`);
    expect(name).toBe(`P_${"x".repeat(74)}.csv`);
  });

  it("names an empty input instead of producing a bare extension", () => {
    expect(scheduleFilename("Buyer_Schedule_", " , ")).toBe("Buyer_Schedule_Unnamed.csv");
  });
});

describe("uniqueFilenames", () => {
  it("appends _2, _3 on collisions and keeps the 80-character cap", () => {
    const base = "Buyer_Schedule_HelmsBriscoe - Associate Director of Global Accounts West Region.csv";
    const a = scheduleFilename("Buyer_Schedule_", "HelmsBriscoe - Associate Director of Global Accounts West Region - AB");
    const b = scheduleFilename("Buyer_Schedule_", "HelmsBriscoe - Associate Director of Global Accounts West Region - DD");
    const c = scheduleFilename("Buyer_Schedule_", "HelmsBriscoe - Associate Director of Global Accounts West Region - EC");
    expect(a).toBe(b);
    expect(base.length).toBeGreaterThan(MAX_FILENAME_LENGTH);
    const unique = uniqueFilenames([a, b, c]);
    expect(new Set(unique).size).toBe(3);
    expect(unique[0]).toBe(a);
    expect(unique[1].endsWith("_2.csv")).toBe(true);
    expect(unique[2].endsWith("_3.csv")).toBe(true);
    expect(unique.every((n) => n.length <= MAX_FILENAME_LENGTH)).toBe(true);
  });

  it("treats names that differ only in case as collisions", () => {
    expect(uniqueFilenames(["A.csv", "a.csv", "B.csv"])).toEqual(["A.csv", "a_2.csv", "B.csv"]);
  });

  it("skips a suffix that is already taken by a real name", () => {
    expect(uniqueFilenames(["x_2.csv", "x.csv", "x.csv"])).toEqual(["x_2.csv", "x.csv", "x_3.csv"]);
  });
});
