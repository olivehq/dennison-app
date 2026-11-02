import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandedHeader } from "./branded-header";

const base = { eventName: "AW 2026", dateLabel: "Tuesday, December 8, 2026", name: "Hyatt Regency", desk: 5 as number | null };
const render = (props: Partial<Parameters<typeof BrandedHeader>[0]>) =>
  renderToStaticMarkup(createElement(BrandedHeader, { primaryColor: null, logoSrc: null, ...base, ...props }));

describe("BrandedHeader", () => {
  it("falls back to the dark neutral band without a color, and has no logo chip without a logo", () => {
    const html = render({});
    expect(html).toContain("Desk 5");
    expect(html).toContain("background-color:var(--foreground);color:var(--background)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("bg-white");
  });

  it("colors the band with the main color and picks readable text", () => {
    expect(render({ primaryColor: "#1e3a8a" })).toContain("background-color:#1e3a8a;color:#ffffff");
    expect(render({ primaryColor: "#fde047" })).toContain("background-color:#fde047;color:#111111");
  });

  it("shows the logo with the event name as its alt text, and no desk for buyers", () => {
    const html = render({ logoSrc: "data:image/png;base64,AAAA", desk: null });
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="AW 2026 logo"');
    // On a white chip, so a logo made for a white page reads on any band color.
    expect(html).toContain("bg-white");
    expect(html).not.toContain("Desk");
  });
});
