import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import LoginPage from "./page";

vi.mock("@/server/auth/session", () => ({ getSession: async () => null }));
vi.mock("./login-form", () => ({ LoginForm: ({ next, sessionEnded }: { next: string; sessionEnded: boolean }) =>
  createElement("div", { "data-next": next }, sessionEnded ? "Your session ended. Sign in to continue." : "Sign in"),
}));

it("does not infer an ended session from a bookmarked destination", async () => {
  const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: "/profile" }) }));
  expect(html).not.toContain("Your session ended");
  expect(html).toContain('data-next="/profile"');
});

it("shows the ended-session notice even when returning to events", async () => {
  const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: "/events", sessionEnded: "1" }) }));
  expect(html).toContain("Your session ended. Sign in to continue.");
});
