import { test, expect } from "@playwright/test";

const hasSupabase = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

test.describe("Manager FREE100 signup", () => {
  test.skip(!hasSupabase, "Requires Supabase test project");

  test.skip("new Google sign-in from /auth/sign-in lands on portal (requires live Google OAuth)", async () => {
    // Manual: sign in with a brand-new Google account at /auth/sign-in → expect /portal/dashboard.
  });

  test("choosing Pro from pricing opens the manager create-account form", async ({ page }) => {
    // The pricing CTAs no longer sign up inline. "Choose <tier>" opens
    // create-account with the tier pre-selected (manager-start-page.tsx →
    // createAccountPath). The FREE100 waiver is no longer a signup-form field —
    // it is applied server-side (PROPLANE_PAYMENT_WAIVER_CODE) — so this verifies the
    // pro-signup ENTRY flow that a real manager takes, with current selectors.
    await page.goto("/partner/pricing");

    await Promise.all([
      page.waitForURL(/\/auth\/create-account.*tier=pro/, { timeout: 30_000 }),
      page.getByRole("button", { name: /choose pro/i }).first().click(),
    ]);

    // The selected tier reaches the email-first verification step.
    await expect(page.getByRole("heading", { name: "Create your property account" })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

  });
});
