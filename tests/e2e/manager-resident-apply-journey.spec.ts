import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { mockStripeAllRoutes, signIn, establishActivePortal } from "../helpers/auth";
import {
  completeManagerSignupOnboarding,
  pickListingSelect,
} from "../helpers/manager-onboarding-e2e";
import {
  createOwnedManagerSignup,
  submitOwnedManagerRegistration,
  type OwnedManagerSignup,
} from "../helpers/owned-manager-signup-e2e";
import { visibleLocator, walkGuestRentalApplication } from "../helpers/rental-wizard-e2e";
import {
  mockFreeApplicationFee,
  resolveManagerUserId,
  setManagerApplicationFeeFree,
} from "../helpers/e2e-supabase";

/**
 * Browser E2E: brand-new manager → publish first listing → guest resident applies
 * → manager sees the application in the portal.
 *
 * Run headed against a local dev server:
 *   PLAYWRIGHT_BASE_URL=http://localhost:3010 PLAYWRIGHT_SKIP_WEBSERVER=1 \
 *     npx playwright test tests/e2e/manager-resident-apply-journey.spec.ts --headed
 */

const EVIDENCE_DIR =
  process.env.MANAGER_RESIDENT_E2E_EVIDENCE ??
  path.resolve(__dirname, "../../.manager-resident-apply-journey");

const DESKTOP = { width: 1440, height: 1000 };

const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key-unset",
  { auth: { persistSession: false } },
);

function shot(page: Page, name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

async function createFreshManager(page: Page, account: OwnedManagerSignup) {

  await page.goto("/partner/pricing");
  await shot(page, "01-pricing");
  await Promise.all([
    page.waitForURL(/\/auth\/create-account/, { timeout: 30_000 }),
    page.getByRole("button", { name: /choose pro|get started|free/i }).first().click(),
  ]);

  await page.getByPlaceholder("Full name").fill(account.fullName);
  await page.getByPlaceholder("Email").fill(account.email);
  await page.getByPlaceholder(/Password \(8\+/).fill(account.password);
  const phoneInput = page.getByPlaceholder("Phone number");
  await expect(phoneInput).toBeRequired();
  await phoneInput.fill(account.phone);
  await shot(page, "02-create-account-filled");
  const managerSubmit = page.locator('[data-attr="manager-trial-signup-submit"]');
  await expect(managerSubmit).toHaveText("Create property account");
  await submitOwnedManagerRegistration(page, managerSubmit, account);

  await page.waitForURL(/\/auth\/(get-started|manager\/choose-plan|connect-google-services)|\/portal/, { timeout: 90_000 });
  if (page.url().includes("/auth/manager/choose-plan")) {
    await shot(page, "02b-choose-plan");
  }
  await completeManagerSignupOnboarding(page);

  if (page.url().includes("/auth/sign-in")) {
    await signIn(page, account.email, account.password, "/portal/dashboard");
    await establishActivePortal(page, "manager", "/portal/dashboard");
  }
  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-attr="manager-properties-create"]')).toBeVisible({ timeout: 60_000 });
  await shot(page, "03-manager-portal");

  return account;
}

async function publishFirstListing(page: Page, stamp: number, managerEmail: string): Promise<string> {
  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  const createBtn = page.locator('[data-attr="manager-properties-create"]');
  await expect(createBtn).toBeEnabled({ timeout: 60_000 });
  await createBtn.click();
  await expect(page.locator("#manager-add-listing-form")).toBeVisible({ timeout: 20_000 });

  const buildingName = `E2E House ${stamp}`;
  await pickListingSelect(page, "Property type", "House");
  await page.getByPlaceholder("e.g. Maple Court").fill(buildingName);
  await page.getByPlaceholder("Start typing a street address").fill("400 Broad St");
  await page.getByRole("button", { name: /South Lake Union/i }).first().click();
  await pickListingSelect(page, "Number of floors", "Single level (1 floor)");
  await pickListingSelect(page, "Total bathrooms", "1 bathroom");
  await shot(page, "04-listing-home");

  const nextBtn = page.getByRole("button", { name: /^continue$/i }).filter({ visible: true }).first();
  for (let step = 0; step < 4; step += 1) {
    await nextBtn.click();
    await page.waitForTimeout(600);
  }

  const monthlyRent = page.getByRole("textbox", { name: /Monthly rent for Room 1/i }).filter({ visible: true }).first();
  if (await monthlyRent.count()) {
    await monthlyRent.fill("1800");
    await monthlyRent.blur();
  } else {
    const wholePlaceRent = visibleLocator(page, "#monthlyRent, input[name='monthlyRent']").first();
    if (await wholePlaceRent.count()) {
      await wholePlaceRent.fill("1800");
      await wholePlaceRent.blur();
    }
  }
  const appFeeToggle = page.getByRole("checkbox", { name: /application fee/i }).filter({ visible: true }).first();
  if ((await appFeeToggle.count()) && (await appFeeToggle.isChecked())) {
    await appFeeToggle.uncheck();
  }
  const reviewBtn = page.getByRole("button", { name: /review & submit/i }).filter({ visible: true }).first();
  if (await reviewBtn.count()) {
    await reviewBtn.click();
  } else {
    await nextBtn.click();
  }
  await shot(page, "05-listing-pricing");

  const submitBtn = page.getByRole("button", { name: /submit listing/i }).filter({ visible: true }).first();
  await expect(submitBtn).toBeVisible({ timeout: 30_000 });
  await expect(submitBtn).toBeEnabled({ timeout: 30_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await submitBtn.click();
  await expect(page.locator("#manager-add-listing-form")).toBeHidden({ timeout: 120_000 });
  await shot(page, "06-listing-live");

  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(buildingName).first()).toBeVisible({ timeout: 30_000 });

  const managerId = await resolveManagerUserId(db, managerEmail);

  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id,status,row_data")
    .eq("manager_user_id", managerId)
    .eq("status", "live")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const propertyId = rows?.[0]?.id;
  if (!propertyId) throw new Error("No live property row found after submit listing");
  return propertyId;
}

test.describe.configure({ mode: "serial", timeout: 600_000 });

test.describe("Manager signup → listing → resident apply", () => {
  test.skip(!hasSupabase, "Requires dev/test Supabase env (.env.local)");

  test("new manager publishes a listing and receives a guest application", async ({ browser }) => {
    test.setTimeout(600_000);
    const stamp = Date.now();
    const account = await createOwnedManagerSignup("e2e-manager");
    const guest = {
      name: "Jordan Applicant",
      email: `e2e-applicant-${stamp}@test.proplane.local`,
      phone: "2065550188",
    };

    let managerContext: BrowserContext | null = null;
    let guestContext: BrowserContext | null = null;
    try {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      managerContext = await browser.newContext({ viewport: DESKTOP });
      const managerPage = await managerContext.newPage();
      await mockStripeAllRoutes(managerPage);

      const manager = await createFreshManager(managerPage, account);
      await setManagerApplicationFeeFree(db, await resolveManagerUserId(db, manager.email));
      const propertyId = await publishFirstListing(managerPage, stamp, manager.email);
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "run.json"),
        JSON.stringify({ email: manager.email, fullName: manager.fullName, propertyId, guest, createdAt: new Date().toISOString() }, null, 2),
      );

      guestContext = await browser.newContext({ viewport: DESKTOP });
      const guestPage = await guestContext.newPage();
      await mockStripeAllRoutes(guestPage);
      await mockFreeApplicationFee(guestPage);
      await walkGuestRentalApplication(guestPage, propertyId, guest);
      await shot(guestPage, "07-application-submitted");

      await managerPage.goto("/portal/properties", { waitUntil: "domcontentloaded" });
      await managerPage.goto("/portal/applications");
      await expect(managerPage.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
      await expect(managerPage.getByText(guest.name).first()).toBeVisible({ timeout: 60_000 });
      await shot(managerPage, "08-manager-sees-application");
    } finally {
      try {
        await guestContext?.close();
      } finally {
        try {
          await managerContext?.close();
        } finally {
          await account.cleanup();
        }
      }
    }
  });
});
