import { describe, expect, it } from "vitest";
import { brandingColorsSchema, readableOn, sniffLogoType } from "./branding";

describe("brandingColorsSchema", () => {
  it("accepts hex colors, lowercases them, and treats empty as none", () => {
    expect(brandingColorsSchema.parse({ primaryColor: "#1D4ED8", accentColor: "" })).toEqual({
      primaryColor: "#1d4ed8",
      accentColor: "",
    });
  });

  it.each(["red", "#fff", "1d4ed8", "#1d4ed8ff", "#gg0000"])("rejects %s", (value) => {
    const result = brandingColorsSchema.safeParse({ primaryColor: value, accentColor: "" });
    expect(result.success).toBe(false);
  });

  it("explains a bad color in plain words", () => {
    const result = brandingColorsSchema.safeParse({ primaryColor: "teal", accentColor: "" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "Use a six-digit color like #1d4ed8, or leave it empty.",
    ]);
  });
});

describe("sniffLogoType", () => {
  it("reads the type from the bytes, not the name", () => {
    expect(sniffLogoType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffLogoType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffLogoType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffLogoType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
  });

  it("refuses anything else", () => {
    expect(sniffLogoType(new TextEncoder().encode("<html><body>hi</body></html>"))).toBeNull();
    expect(sniffLogoType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(sniffLogoType(new Uint8Array())).toBeNull();
  });
});

describe("readableOn", () => {
  it("picks white on dark colors and near-black on light ones", () => {
    expect(readableOn("#1e3a8a")).toBe("#ffffff");
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#fde047")).toBe("#111111");
    expect(readableOn("#ffffff")).toBe("#111111");
  });
});
