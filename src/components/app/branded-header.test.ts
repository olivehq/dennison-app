import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandedHeader } from "./branded-header";

const base = { eventName: "AW 2026", dateLabel: "Tuesday, December 8, 2026", name: "Hyatt Regency", desk: 5 as number | null };
const render = (props: Partial<Parameters<typeof BrandedHeader>[0]>) =>
  renderToStaticMarkup(createElement(BrandedHeader, { primaryColor: null, logoSrc: null, ...base, ...props }));

describe("BrandedHeader", () => {
  it("renders plain text without a color or logo", () => {
    const html = render({});
    expect(html).toContain("Desk 5");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("color-mix");
    expect(html).not.toContain("border-t-8");
  });

  it("applies the main color, with a readable desk badge", () => {
    const dark = render({ primaryColor: "#1e3a8a" });
    expect(dark).toContain("border-top-color:#1e3a8a");
    expect(dark).toContain("background-color:#1e3a8a;color:#ffffff");
    expect(render({ primaryColor: "#fde047" })).toContain("background-color:#fde047;color:#111111");
  });

  it("shows the logo with the event name as its alt text, and no desk for buyers", () => {
    const html = render({ logoSrc: "data:image/png;base64,AAAA", desk: null });
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="AW 2026 logo"');
    expect(html).not.toContain("Desk");
  });
});
