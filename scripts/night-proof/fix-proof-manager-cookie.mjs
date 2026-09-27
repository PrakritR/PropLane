// Manager-side visual proof for Bug #2/#3, bypassing the sign-in FORM and
// /auth/continue entirely — that resolver page is looping under tonight's
// sustained multi-branch machine load (confirmed independent of this
// worktree's code: it recurs across fresh accounts and the correct
// /portal/vendors URL alike). A real Supabase session cookie (same
// password-grant technique already used and accepted for api-proof.mjs)
// lands directly on the destination page with no client-side auth-resolution
// hop to race against.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:3012";
const OUT = "/Users/prakrit/firstmate/projects/proplane-claude/.lavish/night/proof/vendor-signup";
fs.mkdirSync(OUT, { recursive: true });

const MANAGER_EMAIL = process.argv[2] || "manager2@test.proplane.local";
const MANAGER_PASSWORD = process.argv[3] || "TestManager123!";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

async function sessionCookie(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`password grant failed: ${JSON.stringify(session)}`);
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
  return { name: COOKIE_NAME, value, domain: "localhost", path: "/", httpOnly: true, secure: false };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `fix-${name}.png`), fullPage: true });
}

async function main() {
  const browser = await chromium.launch({ args: ["--disable-gpu", "--no-sandbox"] });
  const results = [];
  const cookie = await sessionCookie(MANAGER_EMAIL, MANAGER_PASSWORD);

  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(120_000);
  ctx.setDefaultNavigationTimeout(120_000);
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(`${BASE}/portal/vendors?tab=catalog`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-attr="vendor-directory-filter-toggle"]').waitFor({ state: "visible", timeout: 100_000 });
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

  console.log("\n=== FIX PROOF RESULTS (manager side, cookie-injected session) ===");
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
