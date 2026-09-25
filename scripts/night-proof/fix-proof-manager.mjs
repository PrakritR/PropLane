// Manager-side-only retry of fix-proof.mjs's Bug #2/#3 checks — Bug #1 is
// already confirmed both by fix-01/fix-02 screenshots and by direct SQL
// (directory_listed:true after a real onboarding run that never touched the
// toggle). This reuses that same fixture vendor (already directory-listed,
// trade Plumbing) and just re-drives the manager side with a robust wait for
// the command bar to hydrate instead of a flat timeout.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:3012";
const OUT = "/Users/prakrit/firstmate/projects/proplane-claude/.lavish/night/proof/vendor-signup";
fs.mkdirSync(OUT, { recursive: true });

const MANAGER_EMAIL = "manager2@test.proplane.local";
const MANAGER_PASSWORD = "TestManager123!";

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `fix-${name}.png`), fullPage: true });
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // /auth/continue is itself an in-flight resolver page (role/portal
  // detection) that can bounce through several intermediate URLs under load
  // — wait for the URL to actually settle (stop changing) rather than just
  // leaving /auth/sign-in once.
  const isAuthTransit = (url) => url.pathname.startsWith("/auth/sign-in") || url.pathname.startsWith("/auth/continue");
  await page.waitForURL((url) => !isAuthTransit(url), { timeout: 180_000 });
  let stableSince = Date.now();
  let lastUrl = page.url();
  while (Date.now() - stableSince < 4000) {
    await page.waitForTimeout(500);
    const cur = page.url();
    if (cur !== lastUrl || isAuthTransit(new URL(cur))) {
      lastUrl = cur;
      stableSince = Date.now();
    }
  }
  await page.waitForFunction(
    () => document.cookie.split(";").some((c) => /sb-.+-auth-token/.test(c.trim())),
    { timeout: 180_000 },
  );
}

async function main() {
  const browser = await chromium.launch({ args: ["--disable-gpu", "--no-sandbox"] });
  const results = [];
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(180_000);
  ctx.setDefaultNavigationTimeout(180_000);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await signIn(page, MANAGER_EMAIL, MANAGER_PASSWORD);
  await page.goto(`${BASE}/portal/vendors?tab=catalog`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-attr="vendor-directory-filter-toggle"]').waitFor({ state: "visible", timeout: 150_000 });
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
  await browser.close();

  console.log("\n=== FIX PROOF RESULTS (manager side) ===");
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
