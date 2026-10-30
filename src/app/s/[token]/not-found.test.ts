import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({ SUPPORT_EMAIL: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env: config }));
import InvalidLink from "./not-found";

it("keeps contact text when support is not configured", () => {
  config.SUPPORT_EMAIL = undefined;
  const html = renderToStaticMarkup(createElement(InvalidLink));
  expect(html).toContain("the AW team");
  expect(html).not.toContain("mailto:");
});

it("links the configured support address without exposing participant tokens", () => {
  config.SUPPORT_EMAIL = "support@dennison.ca";
  const html = renderToStaticMarkup(createElement(InvalidLink));
  expect(html).toContain('href="mailto:support@dennison.ca"');
  expect(html).toContain("the AW team</a>");
  expect(html).not.toContain("/s/");
});
