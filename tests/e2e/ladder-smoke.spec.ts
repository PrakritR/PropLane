import { test, expect } from "@playwright/test";

/**
 * Fast ladder smoke — run against each agent localhost via:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:<port> npx playwright test ladder-smoke.spec.ts
 * Or: bin/fm-proplane-branch-e2e.sh --smoke (from firstmate home)
 */
test.describe("Ladder smoke", () => {
  test("public home loads", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /^propLane$/i }).first()).toBeVisible();
  });

  test("sign-in page loads", async ({ page }) => {
    await page.goto("/auth/sign-in");
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await expect(page.getByPlaceholder("Password")).toBeVisible();
  });

  test("protected portal redirects to sign-in", async ({ page }) => {
    await page.goto("/portal/dashboard");
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });
});
