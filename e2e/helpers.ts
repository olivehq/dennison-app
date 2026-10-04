import { expect, test as base, type Page } from "@playwright/test";

export const E2E_ADMIN = { email: "e2e@example.com", name: "E2E Admin", password: "e2e-password-1234" };
export const DEMO_EVENT = "AW 2025 Appointment Show";

/** Every test fails if the page logs a Content-Security-Policy violation. */
export const test = base.extend<{ cspErrors: string[] }>({
  cspErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && /Content Security Policy/i.test(message.text())) errors.push(message.text());
      });
      await use(errors);
      expect(errors, "CSP violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN.email);
  await page.getByLabel("Password").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/events$/);
}

export async function openDemoEvent(page: Page) {
  await page.getByRole("link", { name: DEMO_EVENT }).click();
  await expect(page.getByRole("heading", { level: 1, name: DEMO_EVENT })).toBeVisible();
}
