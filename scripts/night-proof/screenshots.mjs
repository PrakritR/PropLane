// Lightweight screenshot pass — sets a real Supabase session cookie directly
// (password grant, same technique as api-proof.mjs) instead of driving the
// sign-in FORM through the browser, which was what kept stalling on cold
// compiles under this machine's load. Only already-curl-warmed routes are
// visited, and each page load is independent (no multi-step click chains).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:3012";
const OUT = "/Users/prakrit/firstmate/projects/proplane-claude/.lavish/night/proof/vendor-signup";
fs.mkdirSync(OUT, { recursive: true });

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
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

async function main() {
  const vendorEmail = process.argv[2] || "night-vendor-signup-4@test.proplane.local";
  const vendorPassword = process.argv[3] || "NightVendor123!";
  const browser = await chromium.launch({ args: ["--disable-gpu", "--no-sandbox"] });

  try {
    const vendorCookie = await sessionCookie(vendorEmail, vendorPassword);
    const managerCookie = await sessionCookie("manager@test.proplane.local", "TestManager123!");

    // Desktop: vendor onboarding (already-completed profile from api-proof.mjs
    // renders with values filled) and the vendor dashboard.
    {
      const ctx = await browser.newContext();
      ctx.setDefaultTimeout(60_000);
      ctx.setDefaultNavigationTimeout(60_000);
      await ctx.addCookies([vendorCookie]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/vendor/onboarding`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      await shot(page, "01-vendor-onboarding-desktop");
      await page.goto(`${BASE}/vendor/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      await shot(page, "02-vendor-dashboard-desktop-linked");
      await ctx.close();
    }

    // Desktop: manager PropLane vendors tab, filtered by trade.
    {
      const ctx = await browser.newContext();
      ctx.setDefaultTimeout(60_000);
      ctx.setDefaultNavigationTimeout(60_000);
      await ctx.addCookies([managerCookie]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/portal/relationships/vendors?tab=catalog`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await shot(page, "03-manager-proplane-vendors-desktop");
      try {
        await page.locator('[data-attr="vendor-directory-filter-toggle"]').click({ timeout: 10_000 });
        await page.locator('[data-attr="vendor-directory-filter-trade"]').click({ timeout: 10_000 });
        await page.getByRole("option", { name: "Plumbing", exact: true }).click({ timeout: 10_000 });
        await page.waitForTimeout(1500);
        await shot(page, "04-manager-filtered-by-trade-desktop");
      } catch (e) {
        console.warn("filter interaction skipped:", e.message);
      }
      await page.goto(`${BASE}/portal/relationships/vendors?tab=yours`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      await shot(page, "05-manager-yours-tab-desktop");
      await ctx.close();
    }

    // Mobile (390px): vendor onboarding + manager PropLane vendors tab.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      ctx.setDefaultTimeout(60_000);
      ctx.setDefaultNavigationTimeout(60_000);
      await ctx.addCookies([vendorCookie]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/vendor/onboarding`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      await shot(page, "06-vendor-onboarding-mobile-390");
      await page.goto(`${BASE}/vendor/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      await shot(page, "07-vendor-dashboard-mobile-390");
      await ctx.close();

      const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
      ctx2.setDefaultTimeout(60_000);
      ctx2.setDefaultNavigationTimeout(60_000);
      await ctx2.addCookies([managerCookie]);
      const page2 = await ctx2.newPage();
      await page2.goto(`${BASE}/portal/relationships/vendors?tab=catalog`, { waitUntil: "domcontentloaded" });
      await page2.waitForTimeout(1500);
      await shot(page2, "08-manager-proplane-vendors-mobile-390");
      await ctx2.close();
    }

    console.log("Screenshots done ->", OUT);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
