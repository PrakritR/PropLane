#!/usr/bin/env node
/**
 * Deep interaction QA — modals, wizards, primary CTAs per portal.
 * PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-deep-portal-interactions.mjs
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { signInToPortal } from "./qa-portal-sign-in.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const BASE = (process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const DATE = new Date().toISOString().slice(0, 10);

/** @type {{ portal: string; severity: string; title: string; detail: string }[]} */
const issues = [];

function issue(portal, severity, title, detail = "") {
  issues.push({ portal, severity, title, detail });
  console.log(`  [${severity}] ${title}`);
}

async function signIn(page, email, password, role, dest) {
  await signInToPortal(page, { email, password, role, home: dest }, BASE);
}

async function managerDeep(page) {
  console.log("\n— Manager deep —");
  await signIn(page, "manager@test.proplane.local", "TestManager123!", "manager", "/portal/properties/listed");
  await page.waitForTimeout(2000);

  const body = await page.locator("body").innerText();
  if (!/live|listed|draft|property/i.test(body)) {
    issue("manager", "high", "Properties list shows no recognizable property UI", body.slice(0, 200));
  }

  const customize = page.getByRole("button", { name: /customize/i });
  if (await customize.count()) {
    await customize.first().click();
    await page.waitForTimeout(500);
    if (!(await page.getByRole("dialog").count())) {
      issue("manager", "medium", "Dashboard customize button does not open modal", "");
    } else await page.keyboard.press("Escape");
  }

  await page.goto(`${BASE}/portal/applications/pending`);
  await page.waitForTimeout(1500);
  const appRows = page.locator("[data-portal-record-row], tr").filter({ hasText: /AXIS|application/i });
  if ((await appRows.count()) === 0 && !/no applications|no pending/i.test(await page.locator("body").innerText())) {
    issue("manager", "low", "Applications pending tab has no rows and no empty state", "");
  }

  await page.goto(`${BASE}/portal/properties/listed`);
  await page.waitForTimeout(1000);
  const addProperty = page.getByRole("button", { name: /add property/i });
  if (await addProperty.count()) {
    await addProperty.first().click();
    await page.waitForTimeout(2000);
    const wizard = await page.locator("body").innerText();
    if (!/address|property|listing|wizard|step/i.test(wizard)) {
      issue("manager", "high", "Add property does not open listing wizard", wizard.slice(0, 200));
    } else {
      const close = page.getByRole("button", { name: /close|cancel|back/i }).first();
      if (await close.count()) await close.click().catch(() => {});
    }
  }

  await page.goto(`${BASE}/portal/leases`);
  await page.waitForTimeout(1500);
  const leaseText = await page.locator("body").innerText();
  if (leaseText.length < 50 && !/no lease|empty|pipeline/i.test(leaseText)) {
    issue("manager", "medium", "Leases page appears blank (no empty state)", "");
  }

  await page.goto(`${BASE}/portal/financials/income`);
  await page.waitForTimeout(1500);
  if (/upgrade|paywall|pro plan/i.test(await page.locator("body").innerText())) {
    issue("manager", "low", "Finances income behind paywall for seeded manager", "Expected test manager has finances access");
  }

  await page.goto(`${BASE}/portal/profile`);
  await page.waitForTimeout(1000);
  if (!/settings|profile|password|notification/i.test(await page.locator("body").innerText())) {
    issue("manager", "medium", "Manager settings page missing expected panels", "");
  }
}

async function residentDeep(page) {
  console.log("\n— Resident deep —");
  await signIn(page, "resident@test.proplane.local", "TestResident123!", "resident", "/resident/dashboard");
  await page.waitForTimeout(2000);

  const dash = await page.locator("body").innerText();
  if (!/dashboard|application|lease|attention/i.test(dash)) {
    issue("resident", "high", "Resident dashboard missing expected content", dash.slice(0, 200));
  }

  const navLinks = page.locator("nav a, [data-portal-nav] a");
  const hrefs = await navLinks.evaluateAll((els) => els.map((e) => e.getAttribute("href")).filter(Boolean));
  for (const locked of ["lease", "payments", "services"]) {
    const link = hrefs.find((h) => h?.includes(locked));
    if (link) {
      const el = page.locator(`a[href="${link}"]`).first();
      const disabled = await el.getAttribute("aria-disabled");
      if (disabled !== "true") {
        await el.click().catch(() => {});
        await page.waitForTimeout(800);
        if (page.url().includes(locked) || page.url().endsWith("/resident")) {
          // locked items should not navigate — if we landed on section might be unlocked (ok)
        }
      }
    }
  }

  await page.goto(`${BASE}/resident/communication/active`);
  await page.waitForTimeout(1500);
  const compose = page.getByRole("button", { name: /compose|new message/i });
  if (await compose.count()) {
    await compose.first().click();
    await page.waitForTimeout(600);
    if (!(await page.getByRole("dialog").count())) {
      issue("resident", "medium", "Resident compose does not open dialog", "");
    } else await page.keyboard.press("Escape");
  }

  await page.goto(`${BASE}/resident/payments`);
  await page.waitForTimeout(1500);
  const payBody = await page.locator("body").innerText();
  if (/tab.*summary|statements/i.test(payBody)) {
    issue("resident", "medium", "Resident payments still exposes Summary/Statements tabs", "");
  }
  const payBtn = page.getByRole("button", { name: /^pay\b|make payment/i });
  if (await payBtn.count()) {
    issue("resident", "low", "Resident has Pay button visible — verify amounts before paying", "");
  }
}

async function vendorDeep(page) {
  console.log("\n— Vendor deep —");
  await signIn(page, "vendor@test.proplane.local", "TestVendor123!", "vendor", "/vendor/dashboard");
  await page.waitForTimeout(2000);

  const dash = await page.locator("body").innerText();
  if (dash.length < 40) issue("vendor", "medium", "Vendor dashboard nearly empty", "");

  await page.goto(`${BASE}/vendor/work-orders`);
  await page.waitForTimeout(1500);
  if (!/service|work order|job|no /i.test(await page.locator("body").innerText())) {
    issue("vendor", "medium", "Vendor services list missing expected copy", "");
  }

  await page.goto(`${BASE}/vendor/financials/invoices`);
  await page.waitForTimeout(1500);
  const inv = await page.locator("body").innerText();
  if (/403|forbidden|not authorized/i.test(inv)) {
    issue("vendor", "high", "Vendor invoices page shows authorization error", inv.slice(0, 200));
  }

  await page.goto(`${BASE}/vendor/payments`);
  await page.waitForTimeout(1500);
  if (/connect|stripe|payout/i.test(await page.locator("body").innerText())) {
    // expected — note if broken CTA
    const connect = page.getByRole("button", { name: /connect|set up|complete/i });
    if (await connect.count()) {
      const disabled = await connect.first().isDisabled();
      if (disabled) issue("vendor", "low", "Vendor Stripe Connect CTA disabled with no explanation", "");
    }
  }
}

async function mobileSpotCheck(page) {
  console.log("\n— Mobile 390px —");
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "manager@test.proplane.local", "TestManager123!", "manager", "/portal/properties/listed");
  await page.waitForTimeout(1500);
  const actions = page.locator('[class*="md:hidden"] button, [class*="md:hidden"] a');
  const texts = await actions.allInnerTexts();
  const dupes = texts.filter((t, i) => texts.indexOf(t) !== i && t.trim().length > 3);
  if (dupes.length > 2) {
    issue("manager", "medium", "Mobile properties may duplicate header actions", dupes.slice(0, 5).join(", "));
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await managerDeep(page);
  await residentDeep(page);
  await vendorDeep(page);
  await mobileSpotCheck(page);
  await browser.close();

  const outDir = join(REPO, "docs/linear/manifests");
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, `qa-deep-${DATE}-cursor1.md`);
  let body = `# Deep portal QA — cursor-1 (${DATE})\n\nBase: ${BASE}\n\n`;
  for (const i of issues) {
    body += `## [${i.severity}] ${i.portal}: ${i.title}\n${i.detail}\n\n`;
  }
  if (!issues.length) body += "_No issues found in deep pass._\n";
  writeFileSync(md, body);
  console.log(`\n${issues.length} deep findings → ${md}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
