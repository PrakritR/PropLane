/**
 * Browser QA for cosigner + application grouping on prakrit (localhost:3000).
 * Run: node scripts/browser-qa-cosigner-applications.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const EMAIL = process.env.E2E_MANAGER_EMAIL || "manager@test.proplane.local";
const PASSWORD = process.env.E2E_MANAGER_PASSWORD || "TestManager123!";

/** @type {{ area: string; severity: "high"|"medium"|"low"; note: string }[]} */
const issues = [];

function issue(area, severity, note) {
  issues.push({ area, severity, note });
}

async function signInManager(page) {
  await page.goto(`${BASE}/auth/sign-in?next=${encodeURIComponent("/portal/properties/listed")}`);
  await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/portal/**", { timeout: 60_000 });
}

async function testCosignerPublicFlow(page) {
  await page.goto(`${BASE}/rent/apply/cosigner`);
  await page.waitForTimeout(800);
  const main = await page.locator("main").innerText();

  if (/Step \d+ of/i.test(main)) issue("Co-signer public", "medium", "Still shows “Step N of M” header");
  if (!/CO-SIGNER APPLICATION/i.test(main)) issue("Co-signer public", "low", "Co-signer eyebrow missing on /rent/apply/cosigner");
  if (/Current address|Driver's License|\bZIP\b/i.test(main)) issue("Co-signer public", "high", "Step 1 shows address/DL fields unexpectedly");

  await page.getByRole("textbox", { name: /PROPLANE/i }).fill("AXIS-TEST1234");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Personal information").waitFor({ timeout: 10_000 });
  const step2 = await page.locator("main").innerText();
  if (/Current address|Driver|ZIP|\bCity\b/i.test(step2)) {
    issue("Co-signer public", "high", "Personal step still asks for address or driver license");
  }
  if (!/Social Security/i.test(step2)) issue("Co-signer public", "medium", "SSN missing from personal step");

  await page.locator("main input").first().fill("QA Cosigner");
  await page.locator('input[type="email"]').fill("qa.cosigner@test.proplane.local");
  await page.locator('input[type="tel"]').fill("2065550177");
  await page.locator('input[type="date"]').fill("1990-01-15");
  await page.getByPlaceholder("123-45-6789").fill("123-45-6789");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Employment").waitFor();
  const step3 = await page.locator("main").innerText();
  if (/Supervisor|Employer address|Annual income|Employment start/i.test(step3)) {
    issue("Co-signer public", "medium", "Employment step still has verbose fields (supervisor, employer address, etc.)");
  }
}

async function testApplyWizardCosignerChoice(page) {
  await page.goto(`${BASE}/rent/apply`);
  await page.waitForTimeout(1500);
  const main = await page.locator("main").innerText();
  if (!/co-signer|Co-signer/i.test(main)) {
    issue("Apply wizard", "medium", "Step 1 may not show primary vs co-signer choice on bare /rent/apply");
    return;
  }
  const cosignerBtn = page.getByRole("button", { name: /co-signer/i }).or(page.getByText(/I am a co-signer/i));
  if (await cosignerBtn.count()) {
    await cosignerBtn.first().click();
    await page.waitForTimeout(500);
    const after = await page.locator("main").innerText();
    if (!/Link to signer/i.test(after)) issue("Apply wizard", "high", "Choosing co-signer does not open co-signer flow");
  }
}

async function testManagerCosignerPreview(page) {
  await page.goto(`${BASE}/portal/properties/listed`);
  await page.waitForTimeout(2000);
  await page.getByText("Ballard House", { exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Application", exact: true }).click();
  await page.waitForTimeout(1500);

  const hasCosigner = await page.getByText("Co-signer application", { exact: true }).count();
  if (!hasCosigner) issue("Property Application tab", "high", "Co-signer application template row missing");
  if (await page.getByText("Short-term co-signer application").count()) {
    issue("Property Application tab", "medium", "Legacy short-term co-signer row still visible — should be one shared form");
  }
  if (await page.getByText("Long-term co-signer application").count()) {
    issue("Property Application tab", "medium", "Legacy long-term co-signer row still visible — should be one shared form");
  }

  if (!hasCosigner) return;

  const views = page.getByRole("button", { name: "View" });
  let opened = false;
  for (let i = 0; i < (await views.count()); i++) {
    await views.nth(i).click();
    await page.waitForTimeout(500);
    if (await page.getByText("CO-SIGNER APPLICATION").isVisible().catch(() => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) {
    issue("Property Application tab", "high", "Could not open Co-signer application View preview modal");
    return;
  }

  const dialog = page.getByRole("dialog").last();
  const t0 = await dialog.innerText();
  if (/Step \d+ of/i.test(t0)) issue("Co-signer preview", "medium", "Preview modal shows numbered step counter");
  if (!/Link to signer/i.test(t0)) issue("Co-signer preview", "medium", "Preview missing Link to signer step");

  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByText("Personal information").waitFor();
  const t1 = await dialog.innerText();
  if (/Current address|Driver/i.test(t1)) issue("Co-signer preview", "high", "Preview personal step still has address/DL");

  await dialog.locator("input").first().fill("Preview Cosigner");
  await dialog.locator('input[type="email"]').fill("preview@test.proplane.local");
  await dialog.locator('input[type="tel"]').fill("2065550166");
  await dialog.locator('input[type="date"]').fill("1985-06-01");
  await dialog.getByPlaceholder("123-45-6789").fill("111-22-3333");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByText("Employment").waitFor();
  const t2 = await dialog.innerText();
  if (/Supervisor|Employer address/i.test(t2)) issue("Co-signer preview", "medium", "Employment preview still has verbose fields");

  await dialog.getByLabel(/not currently employed/i).check();
  await dialog.locator("input").last().fill("4500");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByText("Background & consent").waitFor();
  await dialog.locator("select").first().selectOption("never");
  await dialog.locator("select").nth(1).selectOption("no");
  await dialog.getByLabel(/consent to a credit/i).check();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByText("Signature").waitFor();
  await dialog.getByRole("button", { name: /Submit|Continue/i }).click();
  const toastOrStay = await dialog.isVisible().catch(() => false);
  if (toastOrStay) {
    // preview should not submit — expect toast or stay on modal
    const t3 = await dialog.innerText();
    if (!/Preview only|preview/i.test(t3)) {
      issue("Co-signer preview", "low", "Preview submit behavior unclear after signature step");
    }
  }
  await page.keyboard.press("Escape");
}

async function testManagerApplicationsGrouping(page) {
  await page.goto(`${BASE}/portal/applications`);
  await page.waitForTimeout(3000);
  const main = await page.locator("main").innerText();
  if (!/Applications/i.test(main)) {
    issue("Manager Applications", "medium", "Could not load Applications section");
    return;
  }
  const hasGroupBadge = /Group \d+\/\d+/i.test(main);
  const hasCosignerRow = /Co-signer/i.test(main);
  if (!hasGroupBadge && !hasCosignerRow) {
    issue("Manager Applications", "low", "No group badges or co-signer nested rows visible (may be empty seed data)");
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await testCosignerPublicFlow(page);
    await testApplyWizardCosignerChoice(page);
    await signInManager(page);
    await testManagerCosignerPreview(page);
    await testManagerApplicationsGrouping(page);
  } catch (e) {
    issue("Browser QA", "high", `Unhandled test error: ${e instanceof Error ? e.message : String(e)}`);
  }

  await browser.close();

  const summary = {
    base: BASE,
    issueCount: issues.length,
    high: issues.filter((i) => i.severity === "high").length,
    medium: issues.filter((i) => i.severity === "medium").length,
    low: issues.filter((i) => i.severity === "low").length,
    issues,
    pass: issues.filter((i) => i.severity === "high").length === 0,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.high > 0 ? 1 : 0);
}

main();
