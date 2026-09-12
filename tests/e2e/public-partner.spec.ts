import { test, expect } from "@playwright/test";

test.describe("Public partner", () => {
  test("loads partner landing with hero and CTAs", async ({ page }) => {
    await page.goto("/partner");
    await expect(page.getByRole("heading", { name: /run the portfolio/i })).toBeVisible();
    await expect(page.getByText(/propLane drafts leases/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /get started free/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /see pricing/i })).toBeVisible();
    await expect(page.getByText(/built for how managers and landlords actually work/i)).toBeVisible();
  });
});
