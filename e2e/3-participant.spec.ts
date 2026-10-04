import { expect, openDemoEvent, signIn, test } from "./helpers";

/** Columns of the access CSV: Name, Email, Contact type, Link. Names may be quoted and hold commas. */
function linksFrom(csv: string): { type: string; link: string }[] {
  return csv
    .replace(/^﻿/, "")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, ""));
      return { type: cells[2], link: cells[3] };
    });
}

test("lock the demo event, then a buyer's link shows nine slots", async ({ page }) => {
  await signIn(page);
  await openDemoEvent(page);
  await page.getByRole("navigation", { name: "Event sections" }).getByRole("link", { name: "Schedule" }).click();

  await page.getByRole("button", { name: "Lock schedule" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Lock this schedule?");
  await dialog.getByRole("button", { name: "Lock schedule" }).click();
  await expect(page.getByText("Locked", { exact: true }).first()).toBeVisible();

  // The access list rotates links (D31), so it is a POST from the signed-in page.
  const eventId = new URL(page.url()).pathname.split("/")[2];
  const response = await page.request.post(`/api/exports/${eventId}/access`, {
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status()).toBe(200);
  const buyer = linksFrom(await response.text()).find((row) => row.type === "Buyer");
  expect(buyer?.link).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);

  await page.goto(new URL(buyer!.link).pathname);
  await expect(page.getByText("Your appointments", { exact: false })).toBeVisible();
  await expect(page.locator("[data-slot='person-schedule'] > li")).toHaveCount(9);
  await expect(page.getByText(/rank/i)).toHaveCount(0);
});
