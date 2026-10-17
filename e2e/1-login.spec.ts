import { DEMO_EVENT, expect, signIn, test } from "./helpers";

test("an admin signs in and sees the events list", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: DEMO_EVENT, exact: true })).toBeVisible();
});

test("a signed-out visitor is sent to the login page", async ({ page }) => {
  await page.goto("/events");
  await expect(page).toHaveURL(/\/login\?next=%2Fevents$/);
});
