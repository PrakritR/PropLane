// Proof for the 3 bugs found by the independent browser-proof pass
// (proof/PROOF.md, proof-findings.json), one attempt, routes pre-warmed.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:3012";
const OUT = "/Users/prakrit/firstmate/projects/proplane-claude/.lavish/night/proof/vendor-signup";
fs.mkdirSync(OUT, { recursive: true });

const VENDOR_EMAIL = process.argv[2] || "night-vendor-signup-fix-1@test.proplane.local";
const VENDOR_PASSWORD = process.argv[3] || "NightVendor123!";
const MANAGER_EMAIL = "manager@test.proplane.local";
const MANAGER_PASSWORD = "TestManager123!";

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `fix-${name}.png`), fullPage: true });
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in") && !url.pathname.startsWith("/auth/continue"), {
    timeout: 180_000,
  });
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

  // ── Bug #1: directory-listed toggle defaults ON for a fresh, incomplete profile ──
  {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await signIn(page, VENDOR_EMAIL, VENDOR_PASSWORD);
    await page.goto(`${BASE}/vendor/onboarding`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Apex Plumbing LLC").waitFor({ state: "visible" });
    await page.waitForTimeout(1000);
    const toggle = page.locator('[data-attr="vendor-onboarding-directory-toggle"]');
    const checkedBeforeAnyEdit = await toggle.isChecked();
    results.push(["Bug #1: directory toggle shows ON for a fresh signup, before touching anything", checkedBeforeAnyEdit]);
    await shot(page, "01-onboarding-toggle-on-by-default");

    await page.locator('[data-attr="vendor-onboarding-business-name"]').fill("Night Proof Plumbing LLC");
    const tradesSelect = page.locator('[data-attr="vendor-onboarding-trades-select"]');
    await tradesSelect.click();
    await page.getByRole("option", { name: "Plumbing", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator('[data-attr="vendor-onboarding-city"]').fill("Seattle, WA");
    await page.locator('[data-attr="vendor-onboarding-zips"]').fill("98101");
    await shot(page, "02-onboarding-filled-toggle-still-on");
    const checkedAfterFill = await toggle.isChecked();
    results.push(["Bug #1: toggle still ON after filling required fields (still not Finished)", checkedAfterFill]);

    await page.locator('[data-attr="vendor-onboarding-finish"]').click();
    await page.waitForURL(/\/vendor\/dashboard/);
    await page.waitForTimeout(1000);

    // Confirm the saved choice actually persisted server-side.
    const saved = await page.evaluate(async () => {
      const r = await fetch("/api/vendor/business-profile", { credentials: "include" });
      return r.json();
    });
    results.push(["Bug #1: saved profile has directoryListed:true after Finish", saved.profile?.directoryListed === true]);
    await ctx.close();
  }

  // ── Bug #3: no list-band icon-vocabulary console error on the vendors tab ──
  // ── Bug #2: the Filter narrows the curated catalog, not just directory rows ──
  {
    const ctx = await newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await signIn(page, MANAGER_EMAIL, MANAGER_PASSWORD);
    await page.goto(`${BASE}/portal/vendors?tab=catalog`, { waitUntil: "domcontentloaded" });
    // Wait for the actual command bar to hydrate (not a flat timeout) — the
    // manager layout's background prefetch sweep can keep the page on
    // skeletons past a couple of seconds under load.
    await page.locator('[data-attr="vendor-directory-filter-toggle"]').waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(1000);
    await shot(page, "03-manager-proplane-vendors-unfiltered");

    const iconViolation = consoleErrors.find((t) => t.includes("outside the documented list-band vocabulary"));
    results.push(["Bug #3: no list-band icon-vocabulary console error on load", !iconViolation]);

    await page.locator('[data-attr="vendor-directory-filter-toggle"]').click();
    await page.locator('[data-attr="vendor-directory-filter-trade"]').click();
    await page.getByRole("option", { name: "HVAC", exact: true }).click();
    await page.waitForTimeout(1500);
    await shot(page, "04-manager-filtered-hvac-catalog-narrowed");

    const rows = page.locator('[data-attr="vendor-catalog-row"]');
    const rowCount = await rows.count();
    const rowTexts = await rows.allTextContents();
    const anyNonHvacCatalogNameLeaked = rowTexts.some((t) => /Emerald City Plumbing|Puget Power Pros|Sparkle Turnover/.test(t));
    results.push(["Bug #2: curated catalog rows (Plumbing/Electrical/Cleaning) are hidden when Trade=HVAC is selected", !anyNonHvacCatalogNameLeaked && rowCount > 0]);
    results.push(["Bug #2: the matching HVAC catalog row (Sound HVAC Collective) is still shown", rowTexts.some((t) => /Sound HVAC Collective/.test(t))]);

    const iconViolationAfterFilter = consoleErrors.find((t) => t.includes("outside the documented list-band vocabulary"));
    results.push(["Bug #3: still no icon-vocabulary console error after opening/using the Filter", !iconViolationAfterFilter]);
    await ctx.close();
  }

  await browser.close();

  console.log("\n=== FIX PROOF RESULTS ===");
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
    /* best effort */
  }
  process.exit(1);
});
