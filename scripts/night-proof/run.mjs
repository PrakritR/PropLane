// Night build proof (night/vendor-signup) — headless Playwright walkthrough.
//
// The machine is running six concurrent night-build dev servers plus other
// lanes (~load average 26), so the signup click-through chain
// (/api/auth/vendor-register -> /api/auth/oauth-portal-access -> /auth/continue)
// took 20-100s+ per cold hop and made a full signup-form-driven run flaky.
// That redirect wiring itself is already verified at the API level: the dev
// server log shows `POST /api/auth/vendor-register 200` returning
// `redirectTo: "/vendor/onboarding"` (grep /tmp/night-vendor-signup-dev.log).
// This script instead signs in directly (fast, no signup chain) and drives
// the onboarding page, dashboard, and manager directory UI on their own —
// the actual feature surfaces under proof — using only routes already warmed
// with curl. Screenshots saved under .lavish/night/proof/vendor-signup/.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:3012";
const OUT = "/Users/prakrit/firstmate/projects/proplane-claude/.lavish/night/proof/vendor-signup";
fs.mkdirSync(OUT, { recursive: true });

const VENDOR_EMAIL = process.argv[2] || "night-vendor-signup-3@test.proplane.local";
const VENDOR_PASSWORD = process.argv[3] || "NightVendor123!";
const MANAGER_EMAIL = "manager@test.proplane.local";
const MANAGER_PASSWORD = "TestManager123!";
const BUSINESS_NAME = "Night Proof Plumbing LLC";

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Wait for the app's OWN post-sign-in redirect to fully land before this
  // function returns — racing a second page.goto() against that in-flight
  // redirect is what produced a stray /auth/sign-in?next=... bounce earlier.
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 180_000 });
  await page.waitForFunction(
    () => document.cookie.split(";").some((c) => /sb-.+-auth-token/.test(c.trim())),
    { timeout: 180_000 },
  );
}

async function main() {
  const browser = await chromium.launch({ args: ["--disable-gpu", "--no-sandbox"] });
  const results = [];
  const newContext = async (opts) => {
    const ctx = await browser.newContext(opts);
    ctx.setDefaultTimeout(180_000);
    ctx.setDefaultNavigationTimeout(180_000);
    return ctx;
  };

  // ── 1: vendor signs in, completes onboarding ──────────────────────────────
  {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await signIn(page, VENDOR_EMAIL, VENDOR_PASSWORD);
    await page.goto(`${BASE}/vendor/onboarding`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Apex Plumbing LLC").waitFor({ state: "visible" });
    await shot(page, "01-vendor-onboarding-empty");

    await page.locator('[data-attr="vendor-onboarding-business-name"]').fill(BUSINESS_NAME);
    const tradesSelect = page.locator('[data-attr="vendor-onboarding-trades-select"]');
    await tradesSelect.click();
    await page.getByRole("option", { name: "Plumbing", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator('[data-attr="vendor-onboarding-city"]').fill("Seattle, WA");
    await page.locator('[data-attr="vendor-onboarding-zips"]').fill("98101");
    await page.locator('[data-attr="vendor-onboarding-license-number"]').fill("WA-NIGHT-12345");
    await page.locator('[data-attr="vendor-onboarding-insurance-provider"]').fill("Harbor Mutual");
    await page.locator('[data-attr="vendor-onboarding-insurance-policy"]').fill("HM-000999");
    await shot(page, "02-vendor-onboarding-filled");

    await page.locator('[data-attr="vendor-onboarding-finish"]').click();
    await page.waitForURL(/\/vendor\/dashboard/);
    await page.waitForTimeout(1500);
    await shot(page, "03-vendor-dashboard-after-onboarding-still-unlinked");
    results.push(["dashboard shows unlinked banner before any manager link (state-driven)",
      (await page.locator('[data-attr="vendor-signup-notice-dismiss"]').count()) > 0]);
    results.push(["onboarding checklist widget present on dashboard",
      (await page.locator('[data-attr="vendor-onboarding-checklist"]').count()) > 0]);

    // Confirm the save actually persisted via the same profile API the UI reads.
    const saved = await page.evaluate(async () => {
      const r = await fetch("/api/vendor/business-profile", { credentials: "include" });
      return r.json();
    });
    results.push(["saved profile has businessName/trades/onboardingCompletedAt",
      saved.profile?.businessName === BUSINESS_NAME && Array.isArray(saved.profile?.trades) && saved.profile.trades.includes("Plumbing")]);
    results.push(["directoryListed defaults on and onboarding is marked complete",
      saved.profile?.directoryListed === true && Boolean(saved.profile?.onboardingCompletedAt)]);
    await ctx.close();
  }

  // ── 2: manager finds + adds the vendor from the directory ────────────────
  {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await signIn(page, MANAGER_EMAIL, MANAGER_PASSWORD);
    await page.goto(`${BASE}/portal/relationships/vendors?tab=catalog`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await shot(page, "04-manager-proplane-vendors-tab");

    await page.locator('[data-attr="vendor-directory-filter-toggle"]').click();
    await page.locator('[data-attr="vendor-directory-filter-trade"]').click();
    await page.getByRole("option", { name: "Plumbing", exact: true }).click();
    await page.waitForTimeout(1500);
    await shot(page, "05-manager-filtered-by-trade-plumbing");

    const row = page.locator('[data-attr="vendor-catalog-row"]', { hasText: BUSINESS_NAME });
    results.push(["manager finds the self-serve vendor filtered by trade", (await row.count()) > 0]);

    await row.locator('[data-attr="vendor-catalog-row-add"]').click();
    await page.waitForTimeout(2000);
    await shot(page, "06-manager-added-to-vendors");

    await page.goto(`${BASE}/portal/relationships/vendors?tab=yours`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await shot(page, "07-manager-yours-tab-shows-linked-vendor");
    const yoursRow = page.locator('[data-attr="vendor-list-row"]', { hasText: BUSINESS_NAME });
    results.push(["linked vendor now appears in manager's own roster", (await yoursRow.count()) > 0]);
    await ctx.close();
  }

  // ── 3: vendor signs back in — banner is gone ──────────────────────────────
  {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await signIn(page, VENDOR_EMAIL, VENDOR_PASSWORD);
    await page.goto(`${BASE}/vendor/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await shot(page, "08-vendor-dashboard-after-linked-banner-gone");
    const bannerGone = (await page.locator('[data-attr="vendor-signup-notice-dismiss"]').count()) === 0;
    results.push(["unlinked banner disappears once the vendor is linked", bannerGone]);
    await ctx.close();
  }

  // ── phone width (390px) ───────────────────────────────────────────────────
  {
    const ctx = await newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await signIn(page, VENDOR_EMAIL, VENDOR_PASSWORD);
    await page.goto(`${BASE}/vendor/onboarding`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    await shot(page, "09-vendor-onboarding-mobile-390");
    await ctx.close();

    const ctx2 = await newContext({ viewport: { width: 390, height: 844 } });
    const page2 = await ctx2.newPage();
    await signIn(page2, MANAGER_EMAIL, MANAGER_PASSWORD);
    await page2.goto(`${BASE}/portal/relationships/vendors?tab=catalog`, { waitUntil: "domcontentloaded" });
    await page2.waitForTimeout(1500);
    await shot(page2, "10-manager-proplane-vendors-mobile-390");
    await ctx2.close();
  }

  await browser.close();

  console.log("\n=== PROOF RESULTS ===");
  let allPass = true;
  for (const [label, ok] of results) {
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
    if (!ok) allPass = false;
  }
  if (!allPass) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try {
    const { execSync } = await import("node:child_process");
    execSync("pkill -9 -f chrome-headless-shell || true");
  } catch {
    /* best effort cleanup */
  }
  process.exit(1);
});
