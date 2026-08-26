import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";
import { completeManagerSignupOnboarding, pickListingSelect } from "../helpers/manager-onboarding-e2e";

/**
 * End-to-end walkthrough: brand-new manager from pricing → account creation →
 * empty portal → first listing draft → every major portal section.
 * Evidence screenshots land in .new-manager-journey/ at repo root.
 */

const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const EVIDENCE_DIR =
  process.env.NEW_MANAGER_EVIDENCE_DIR ??
  path.resolve(__dirname, "../../.new-manager-journey");

function shot(page: import("@playwright/test").Page, name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

const PORTAL_SECTIONS = [
  { name: "dashboard", path: "/portal/dashboard" },
  { name: "properties", path: "/portal/properties" },
  { name: "tours", path: "/portal/tours/pending" },
  { name: "applications", path: "/portal/applications" },
  { name: "leases", path: "/portal/leases" },
  { name: "residents", path: "/portal/residents/current" },
  { name: "payments", path: "/portal/payments" },
  { name: "services", path: "/portal/services/requests" },
  { name: "inbox", path: "/portal/communication/active" },
  { name: "documents", path: "/portal/documents/income-documents" },
  { name: "finances", path: "/portal/financials/income" },
  { name: "promotion", path: "/portal/promotion" },
  { name: "team", path: "/portal/relationships" },
  { name: "settings", path: "/portal/profile" },
  { name: "feedback", path: "/portal/bugs-feedback" },
] as const;

test.describe("New manager — full journey from scratch", () => {
  test.skip(!hasSupabase, "Requires the dev/test Supabase project");

  test("pricing → signup → portal tour → first listing draft", async ({ page }) => {
    test.setTimeout(300_000);

    await mockStripeAllRoutes(page);

    const stamp = Date.now();
    const email = `fresh-manager-${stamp}@test.proplane.local`;
    const password = "FreshManager123!";
    const fullName = "Fresh Journey Manager";
    const phone = "2065550199";

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, "credentials.json"),
      JSON.stringify({ email, password, fullName, createdAt: new Date().toISOString() }, null, 2),
    );

    // ── 1. Discover pricing and choose Pro ──────────────────────────────────
    await page.goto("/partner/pricing");
    await shot(page, "01-pricing");
    await Promise.all([
      page.waitForURL(/\/auth\/create-account.*tier=pro/, { timeout: 30_000 }),
      page.getByRole("button", { name: /choose pro/i }).first().click(),
    ]);
    await shot(page, "02-create-account-form");

    // ── 2. Create account, then pick property manager portal ─────────────────
    await page.getByPlaceholder("Full name").fill(fullName);
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder(/Password \(8\+/).fill(password);
    const phoneInput = page.locator("#mgr-phone-input, #signup-phone").filter({ visible: true }).first();
    if (await phoneInput.count()) await phoneInput.fill(phone);
    await shot(page, "03-create-account-filled");
    await page.getByRole("button", { name: /create account/i }).click();

    await page.waitForURL(/\/auth\/(get-started|manager\/choose-plan)|\/portal/, { timeout: 90_000 });
    if (page.url().includes("/auth/get-started")) {
      await shot(page, "03b-get-started-chooser");
    }
    await completeManagerSignupOnboarding(page);
    await page.waitForLoadState("domcontentloaded");
    await shot(page, "04-portal-landing");

    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-attr="manager-properties-create"]')).toBeVisible({ timeout: 60_000 });

    // ── 3. Tour every major portal section (fresh empty account) ────────────
    const sectionResults: Array<{ name: string; ok: boolean; note?: string }> = [];
    for (const section of PORTAL_SECTIONS) {
      try {
        await page.goto(section.path, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
        await shot(page, `05-portal-${section.name}`);
        sectionResults.push({ name: section.name, ok: true });
      } catch (err) {
        sectionResults.push({
          name: section.name,
          ok: false,
          note: err instanceof Error ? err.message.slice(0, 120) : String(err),
        });
        await shot(page, `05-portal-${section.name}-FAIL`);
      }
    }
    fs.writeFileSync(path.join(EVIDENCE_DIR, "portal-sections.json"), JSON.stringify(sectionResults, null, 2));

    const failedSections = sectionResults.filter((s) => !s.ok);
    expect(failedSections, `Portal sections that failed: ${JSON.stringify(failedSections)}`).toHaveLength(0);

    // ── 4. Start first listing (Home step + save draft) ─────────────────────
    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    const createBtn = page.locator('[data-attr="manager-properties-create"]');
    await expect(createBtn).toBeEnabled({ timeout: 60_000 });
    await createBtn.click();
    await expect(page.locator("#manager-add-listing-form")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/new listing · home/i)).toBeVisible();
    await shot(page, "06-listing-wizard-open");

    await pickListingSelect(page, "Property type", "House");
    await page.getByPlaceholder("e.g. Maple Court").fill(`Journey House ${stamp}`);
    await page.getByPlaceholder("Start typing a street address").fill("400 Broad St");
    await page.getByRole("button", { name: /South Lake Union/i }).first().click();
    await pickListingSelect(page, "Number of floors", "Single level (1 floor)");
    await pickListingSelect(page, "Total bathrooms", "1 bathroom");
    await shot(page, "07-listing-home-step");

    await page.getByRole("button", { name: /save & close/i }).click();
    await expect(page.locator("#manager-add-listing-form")).toBeHidden({ timeout: 45_000 });
    await shot(page, "08-listing-draft-saved");

    await expect(page.getByRole("button", { name: /Drafts\s+[1-9]/ })).toBeVisible({ timeout: 15_000 });
    await shot(page, "09-drafts-tab-has-listing");

    // ── 5. Team tab — empty co-managers state ───────────────────────────────
    await page.goto("/portal/relationships");
    await expect(page.getByText(/no co-managers yet/i)).toBeVisible({ timeout: 15_000 });
    await shot(page, "10-team-empty-state");

    console.log(`NEW MANAGER JOURNEY OK — ${email} / ${password}`);
    console.log(`Evidence: ${EVIDENCE_DIR}`);
  });
});
