import { test, expect } from "@playwright/test";

test.describe("Public tours", () => {
  test("tours contact page with no home goes to the home picker", async ({ page }) => {
    await page.goto("/rent/tours-contact");
    await expect(page).toHaveURL(/\/rent\/browse/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
