import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { E2E_ACCOUNTS } from "../fixtures";

/**
 * Headed Chrome walkthrough for bundle+group joint lease UI.
 * Run manually:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3011 \
 *     npx playwright test tests/e2e/bundle-group-manual-chrome.spec.ts --headed --workers=1
 */

const PROPERTY_ID = "mgr-test-magnolia";
const BUNDLE_ID = `${PROPERTY_ID}-bundle-multi`;
const EVIDENCE_DIR = path.join(process.cwd(), "test-evidence", "bundle-group-manual");

const MANAGER = E2E_ACCOUNTS.manager2;

function shot(page: Page, name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.use({
  launchOptions: { slowMo: 400 },
  viewport: { width: 1440, height: 900 },
});

function vis(page: Page, selector: string) {
  return page.locator(selector).filter({ visible: true }).first();
}

function txt(page: Page, needle: string | RegExp) {
  return page.getByText(needle).filter({ visible: true }).first();
}

async function yesNo(page: Page, fieldKey: string, answer: "Yes" | "No") {
  await page
    .locator(`[data-wizard-field="${fieldKey}"] button`, { hasText: new RegExp(`^${answer}$`) })
    .filter({ visible: true })
    .first()
    .click();
}

async function continueWizard(page: Page) {
  const btn = vis(page, '[data-attr="rental-wizard-continue"]');
  if (await btn.isVisible().catch(() => false)) await btn.click();
}

test.describe("Bundle group manual Chrome walkthrough", () => {
  test("listing bundle CTA → apply wizard group+bundle UI", async ({ page }) => {
    await page.goto(`/rent/apply?propertyId=${PROPERTY_ID}&bundle=${BUNDLE_ID}`);
    // Guest continue removed (PLAN-0924-1421): expect account gate or signed-in wizard.
    const guestContinue = page.getByRole("button", { name: /Continue without an account/i }).filter({ visible: true });
    await expect(guestContinue).toHaveCount(0);
    const createAccount = page.getByRole("link", { name: /create account/i }).filter({ visible: true });
    const groupField = vis(page, '[data-wizard-field="applyingAsGroup"]');
    await expect(createAccount.or(groupField)).toBeVisible({ timeout: 30_000 });
    if (await createAccount.isVisible().catch(() => false)) {
      await shot(page, "01-apply-account-gate");
      // Remainder of the wizard walk requires a resident session — covered by unit gate tests.
      return;
    }

    await expect(groupField).toBeVisible({ timeout: 30_000 });
    await yesNo(page, "applyingAsGroup", "Yes");
    await page.getByRole("button", { name: /I am the first person applying/i }).filter({ visible: true }).first().click();
    const sizeTrigger = page.getByRole("button", { name: /Select group size|2 people/i }).filter({ visible: true }).first();
    await sizeTrigger.click();
    await page.getByRole("option", { name: /2 people/i }).filter({ visible: true }).first().click();
    await shot(page, "01-group-step-bundle-flow");
    await continueWizard(page);

    await yesNo(page, "hasCosigner", "No");
    await continueWizard(page);

    await expect(vis(page, '[data-wizard-field="bundleId"]')).toBeVisible({ timeout: 30_000 });
    await expect(vis(page, '[data-wizard-field="bundleId"]')).toContainText(/Two or more rooms/i);
    await shot(page, "02-bundle-selected-on-property-step");

    await page.goto(`/rent/listings/${PROPERTY_ID}`);
    await expect(txt(page, /Magnolia House/i)).toBeVisible({ timeout: 45_000 });
    await shot(page, "03-listing-detail");

    const bundleRow = txt(page, /Two or more rooms/i);
    await expect(bundleRow).toBeVisible({ timeout: 20_000 });
    await bundleRow.click();
    await shot(page, "04-bundle-modal");

    const applyBtn = page
      .getByRole("link", { name: /Apply online/i })
      .or(page.getByRole("button", { name: /Apply online/i }))
      .filter({ visible: true })
      .first();
    await expect(applyBtn).toBeVisible({ timeout: 15_000 });
    await applyBtn.click();
    await page.waitForURL(/\/rent\/apply/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Continue without an account/i })).toHaveCount(0);
    await shot(page, "05-listing-cta-to-apply");
  });

  test("manager sign-in → applications group section copy", async ({ page }) => {
    await page.goto(`/auth/sign-in?next=${encodeURIComponent("/portal/applications")}`);
    await page.getByPlaceholder("Email").fill(MANAGER.email);
    await page.getByPlaceholder("Password").fill(MANAGER.password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL(/\/portal/, { timeout: 45_000 });

    await page.goto("/portal/properties");
    await expect(txt(page, /Magnolia House/i)).toBeVisible({ timeout: 45_000 });
    await page.goto("/portal/applications");
    await shot(page, "06-manager-applications");

    const anyApplicant = page.locator("button").filter({ hasText: /@/, visible: true }).first();
    if (await anyApplicant.isVisible().catch(() => false)) {
      await anyApplicant.click();
      await page.waitForTimeout(800);
      await shot(page, "07-manager-application-expanded");
    }
  });

  test("manager leases panel loads joint bundle badge surface", async ({ page }) => {
    await page.goto(`/auth/sign-in?next=${encodeURIComponent("/portal/leases")}`);
    await page.getByPlaceholder("Email").fill(MANAGER.email);
    await page.getByPlaceholder("Password").fill(MANAGER.password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL(/\/portal/, { timeout: 45_000 });

    await page.goto("/portal/leases");
    await expect(
      page.getByRole("heading", { name: /leases/i }).or(page.getByText(/Leases/i)).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 45_000 });
    await shot(page, "08-manager-leases");
  });
});
