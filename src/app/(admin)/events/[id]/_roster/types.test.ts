import { describe, expect, it } from "vitest";
import { healthFor, matchesLinkFilter, parseLinkFilter, parseSearchQuery, queryWithParam, type LinkInfo } from "./types";

const link = (state: "active" | "revoked" | "expired"): LinkInfo => ({ tokenId: "t", state });

describe("parseLinkFilter", () => {
  it("accepts the four states and falls back to any link", () => {
    expect(["active", "revoked", "expired", "none"].map(parseLinkFilter)).toEqual(["active", "revoked", "expired", "none"]);
    expect(parseLinkFilter(undefined)).toBe("all");
    expect(parseLinkFilter("bogus")).toBe("all");
    expect(parseLinkFilter(["revoked"])).toBe("all");
  });
});

describe("matchesLinkFilter", () => {
  it("lets everything through for any link", () => {
    expect(matchesLinkFilter("all", [null])).toBe(true);
    expect(matchesLinkFilter("all", [])).toBe(true);
  });

  it("matches a participant by the state of their one link", () => {
    expect(matchesLinkFilter("active", [link("active")])).toBe(true);
    expect(matchesLinkFilter("revoked", [link("active")])).toBe(false);
    expect(matchesLinkFilter("expired", [link("expired")])).toBe(true);
    expect(matchesLinkFilter("none", [null])).toBe(true);
    expect(matchesLinkFilter("none", [link("revoked")])).toBe(false);
  });

  it("matches a supplier when any contact is in the state", () => {
    const mixed = [link("active"), link("revoked")];
    expect(matchesLinkFilter("active", mixed)).toBe(true);
    expect(matchesLinkFilter("revoked", mixed)).toBe(true);
    expect(matchesLinkFilter("expired", mixed)).toBe(false);
    expect(matchesLinkFilter("none", mixed)).toBe(false);
    expect(matchesLinkFilter("none", [link("active"), null])).toBe(true);
  });

  it("counts a supplier with no contact email as having no link", () => {
    expect(matchesLinkFilter("none", [])).toBe(true);
    expect(matchesLinkFilter("active", [])).toBe(false);
  });
});

describe("queryWithParam", () => {
  it("sets the key and keeps the other filters", () => {
    expect(queryWithParam("?status=all", "q", "hyatt", "")).toBe("?status=all&q=hyatt");
    expect(queryWithParam("?q=old&link=revoked", "q", "new", "")).toBe("?q=new&link=revoked");
  });

  it("drops the key at its default and returns an empty string when nothing is left", () => {
    expect(queryWithParam("?status=all&q=hyatt", "q", "", "")).toBe("?status=all");
    expect(queryWithParam("?q=hyatt", "q", "", "")).toBe("");
    expect(queryWithParam("", "status", "active", "active")).toBe("");
  });

  it("encodes the value", () => {
    expect(queryWithParam("", "q", "A&B Hotel", "")).toBe("?q=A%26B+Hotel");
  });
});

describe("parseSearchQuery", () => {
  it("reads one value and ignores a missing or repeated key", () => {
    expect(parseSearchQuery("hyatt")).toBe("hyatt");
    expect(parseSearchQuery(undefined)).toBe("");
    expect(parseSearchQuery(["a", "b"])).toBe("");
  });
});

describe("healthFor", () => {
  it("flags active people below the minimum and above the maximum", () => {
    expect(healthFor(0, 6, 9, true)).toBe("low");
    expect(healthFor(7, 6, 9, true)).toBe("ok");
    expect(healthFor(10, 6, 9, true)).toBe("high");
    expect(healthFor(0, 6, 9, false)).toBe("none");
  });

  it("never flags a withdrawn person, with or without meetings (D153)", () => {
    expect(healthFor(0, 6, 9, true, true)).toBe("ok");
    expect(healthFor(12, 6, 9, true, true)).toBe("ok");
    expect(healthFor(0, 6, 9, false, true)).toBe("none");
  });
});
