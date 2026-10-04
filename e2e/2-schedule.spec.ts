import { expect, openDemoEvent, signIn, test } from "./helpers";

test("the demo schedule opens and switches views", async ({ page }) => {
  await signIn(page);
  await openDemoEvent(page);
  await page.getByRole("navigation", { name: "Event sections" }).getByRole("link", { name: "Schedule" }).click();
  await expect(page.getByRole("button", { name: /^Desk 1, .+ Open schedule$/ })).toBeVisible();

  await page.getByRole("radio", { name: "Buyers" }).click();
  await expect(page).toHaveURL(/view=buyer/);
  await page.getByRole("radio", { name: "By slot" }).click();
  await expect(page).toHaveURL(/view=slot/);
  await page.getByRole("radio", { name: "Supplier desks" }).click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(page.getByRole("button", { name: /^Desk 1, .+ Open schedule$/ })).toBeVisible();
});
