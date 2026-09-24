import { test, expect } from "@playwright/test";

test.describe("Public rental application gate", () => {
  test("known property shows resident signup gate without guest path", async ({ page }) => {
    await page.goto("/rent/apply?propertyId=mgr-test-fir");
    await expect(page.getByRole("heading", { name: /create your resident account/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("link", { name: /create account/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
    await expect(page.locator('[data-attr="public-apply-continue-guest"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /continue without an account/i })).toHaveCount(0);
  });

  test("create-account link carries apply next path", async ({ page }) => {
    await page.goto("/rent/apply?propertyId=mgr-test-fir");
    const create = page.getByRole("link", { name: /create account/i });
    await expect(create).toBeVisible({ timeout: 15_000 });
    const href = await create.getAttribute("href");
    expect(href).toContain("/auth/create-account");
    expect(href).toMatch(/next=/);
  });
});
