import { test, expect } from "@playwright/test";
import path from "node:path";
import { E2E_ACCOUNTS } from "../fixtures";

test.describe("Application deep link", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test accounts");
  test("signed-out sign-in preserves the requested section and query", async ({ page }) => {
    const destination = "/portal/applications?bucket=pending";
    await page.goto(destination);
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(destination);
    await page.getByPlaceholder("Email").fill(E2E_ACCOUNTS.manager.email);
    await page.getByPlaceholder("Password").fill(E2E_ACCOUNTS.manager.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(url => url.pathname === "/auth/choose-portal" || url.pathname.startsWith("/portal/"), { timeout: 45_000 });
    // A temporary portal URL can still redirect to the chooser. Wait for the
    // destination screen before deciding whether a role choice is required.
    await expect(page.getByRole("heading", { name: /^(Choose a portal|Applications)$/ })).toBeVisible({ timeout: 30_000 });
    // Drive the chooser already reached by sign-in rather than changing its next.
    if (new URL(page.url()).pathname === "/auth/choose-portal") {
      expect(new URL(page.url()).searchParams.get("next")).toBe(destination);
      const property = page.getByRole("button", { name: /^Property\b/i }).first();
      await expect(property).toBeVisible();
      await property.click();
    }
    await expect(page).toHaveURL(/\/portal\/applications\?bucket=pending/);
    await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
  });
});

test.describe("Applications initial read", () => {
  test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test manager");
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.clear();
      for (const key of Object.keys(localStorage)) if (key.includes("manager-applications")) localStorage.removeItem(key);
    });
  });
  test("shows loading while the first real applications response is pending", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/manager-applications*", async route => { await gate; await route.continue(); });
    await page.goto("/portal/applications/pending", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status", { name: "Loading records" })).toBeVisible();
    await expect(page.getByText("No applications pending", { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("status", { name: "Loading records" })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("alert").filter({ hasText: "Could not load applications." })).toHaveCount(0);
  });
  test("failed read shows retry and recovers against the real endpoint", async ({ page }) => {
    await page.route("**/api/manager-applications*", route => route.fulfill({ status: 503, json: { error: "Test outage" } }));
    await page.goto("/portal/applications/pending", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert").filter({ hasText: "Could not load applications." })).toBeVisible();
    await expect(page.getByText("No applications pending", { exact: true })).toHaveCount(0);
    await page.unroute("**/api/manager-applications*");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Could not load applications." })).toHaveCount(0, { timeout: 30_000 });
  });
});


test.describe("Signed-out paid application recovery", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("payment return retries without opening an application form", async ({ page }) => {
    let attempts = 0;
    await page.route("**/api/stripe/application-fee-verify", route => {
      attempts++;
      return attempts === 1
        ? route.fulfill({ status: 503, json: { error: "Test verification outage" } })
        : route.fulfill({ status: 200, json: { paid: true, applicationPromoted: true, applicationAxisId: "PROPLANE-QA-RECOVERY", applicationSetupEmailSent: true } });
    });
    await page.goto("/rent/apply?propertyId=mgr-test-alder&fee_checkout=return&session_id=cs_browser_recovery");
    await expect(page.getByRole("heading", { name: "Payment confirmation", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Test verification outage" })).toBeVisible();
    await expect(page.locator('[data-attr="rental-wizard-continue"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Retry verification", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Application submitted", exact: true })).toBeVisible();
    await expect(page.getByText(/Check your email for your resident account setup link/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Create your resident account", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-attr="rental-wizard-continue"]')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("session_id")).toBe("cs_browser_recovery");
  });
});
