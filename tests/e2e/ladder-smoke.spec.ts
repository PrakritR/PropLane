import { test, expect } from "@playwright/test";

/**
 * Fast ladder smoke — run against each agent localhost via:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:<port> npx playwright test ladder-smoke.spec.ts
 * Or: bin/fm-proplane-branch-e2e.sh --smoke (from firstmate home)
 */
test.describe("Ladder smoke", () => {
  test("public home loads", async ({ page }) => {
    await page.goto("/");
    // Structural, deliberately not the hero's words: this is the release ladder's
    // gate, so it must fail when the page does not load, never when marketing
    // rewrites the headline (how the previous `^propLane$` assertion went stale).
    await expect(page.locator("#rlp-hero-title")).toBeVisible();
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
