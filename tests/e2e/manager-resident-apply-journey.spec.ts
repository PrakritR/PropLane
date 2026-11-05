import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { linkSignupJournals } from "../helpers/signup-proof-journal";
import { revokeSignupContext } from "../helpers/signup-proof-session";
import { mockStripeAllRoutes } from "../helpers/auth";
import { reserveSignupProof, completeSignupProof, completeResidentSignupProof, recordSignupInventory, type SignupProofManifest } from "../helpers/signup-proof-e2e";
import {
  pickListingSelect,
} from "../helpers/manager-onboarding-e2e";
import { visibleLocator, openApplyAccountGate, walkSignedInRentalApplication, applicationSubmitted } from "../helpers/rental-wizard-e2e";
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

const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const EVIDENCE_DIR =
  process.env.MANAGER_RESIDENT_E2E_EVIDENCE ??
  path.resolve(__dirname, "../../.manager-resident-apply-journey");

const DESKTOP = { width: 1440, height: 1000 };

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key-unset",
  { auth: { persistSession: false } },
);

function shot(page: Page, name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

async function createFreshManager(page: Page, reservation: { manifest: SignupProofManifest; file: string }) {
  await page.goto("/partner/pricing");
  await shot(page, "01-pricing");
  await Promise.all([
    page.waitForURL(/\/auth\/create-account/, { timeout: 30_000 }),
    page.getByRole("button", { name: /choose pro|get started|free/i }).first().click(),
  ]);

  const managerId = await completeSignupProof(page, reservation);
  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-attr="manager-properties-add-top"], [data-attr="manager-properties-create"]')).toBeVisible({ timeout: 60_000 });
  await shot(page, "03-manager-portal");

  return { email: reservation.manifest.email, managerId, reservation };
}

async function publishFirstListing(page: Page, reservation: { manifest: SignupProofManifest; file: string }, managerId: string): Promise<string> {
  const marker = reservation.manifest.email.split("-")[2]!;
  const buildingName = `P8 listing ${marker}`;
  recordSignupInventory(reservation, { namespace: "property", state: "unresolved", actorId: managerId, marker });
  recordSignupInventory(reservation, { namespace: "listing", state: "unresolved", actorId: managerId, marker });
  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  const createBtn = page.locator('[data-attr="manager-properties-add-top"], [data-attr="manager-properties-create"]');
  await expect(createBtn).toBeEnabled({ timeout: 60_000 });
  await createBtn.click();
  await expect(page.locator("#manager-add-listing-form")).toBeVisible({ timeout: 20_000 });

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

  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id,status,row_data,property_data")
    .eq("manager_user_id", managerId)
    .eq("status", "live")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const matching = rows?.filter((row) => JSON.stringify([row.row_data, row.property_data]).includes(buildingName)) ?? [];
  if (matching.length !== 1) throw new Error("Expected exactly one owned live listing for this run.");
  const propertyId = matching[0]?.id;
  if (!propertyId) throw new Error("No live property row found after submit listing");
  recordSignupInventory(reservation, { namespace: "property", state: "resolved", actorId: managerId, marker, id: propertyId });
  // Listing and related thread identities must be reconciled before cleanup can be authorized.
  return propertyId;
}

test.describe.configure({ mode: "serial", timeout: 600_000 });

test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("Manager signup → listing → resident apply", () => {
  test.skip(!hasSupabase, "Requires dev/test Supabase env (.env.local)");

  test("new manager publishes a listing and receives a resident application", async ({ browser }) => {
    test.setTimeout(600_000);
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    const managerContext = await browser.newContext({ viewport: DESKTOP });
    let guestContext: import("@playwright/test").BrowserContext | undefined;
    let managerReservation: Awaited<ReturnType<typeof reserveSignupProof>> | undefined;
    let residentReservation: Awaited<ReturnType<typeof reserveSignupProof>> | undefined;
    try {
      const managerPage = await managerContext.newPage();
      managerPage.setDefaultTimeout(30_000);
      await mockStripeAllRoutes(managerPage);

      managerReservation = await reserveSignupProof("listing");
      const manager = await createFreshManager(managerPage, managerReservation);
      await setManagerApplicationFeeFree(db, await resolveManagerUserId(db, manager.email));
      const propertyId = await publishFirstListing(managerPage, manager.reservation, manager.managerId);


      const resident = await reserveSignupProof("resident");
      residentReservation = resident;
      const guest = { name: resident.manifest.fullName, email: resident.manifest.email, phone: resident.manifest.phone.slice(2) };
      guestContext = await browser.newContext({ viewport: DESKTOP });
      const guestPage = await guestContext.newPage();
      guestPage.setDefaultTimeout(30_000);
      await mockStripeAllRoutes(guestPage);
      await mockFreeApplicationFee(guestPage);
      await openApplyAccountGate(guestPage, propertyId);
      await guestPage.getByRole("link", { name: /create account/i }).filter({ visible: true }).first().click();
      await completeResidentSignupProof(guestPage, resident, propertyId);
      const marker = manager.reservation.manifest.email.split("-")[2]!;
      if (!resident.manifest.actorId) throw new Error("Resident identity unavailable.");
      linkSignupJournals(manager.reservation, resident);
      recordSignupInventory(manager.reservation, { namespace: "application", state: "unresolved", actorId: manager.managerId, marker, propertyId, residentActorId: resident.manifest.actorId });
      recordSignupInventory(manager.reservation, { namespace: "resident-threads", state: "unresolved", actorId: manager.managerId, marker, propertyId, residentActorId: resident.manifest.actorId });
      await walkSignedInRentalApplication(guestPage, propertyId, guest);
      await expect(applicationSubmitted(guestPage)).toBeVisible();
      const application = await db.from("manager_application_records").select("id,manager_user_id,resident_email,property_id,assigned_property_id").eq("manager_user_id", manager.managerId).eq("resident_email", guest.email);
      if (application.error || application.data?.length !== 1 || !application.data.some((row) => row.property_id === propertyId || row.assigned_property_id === propertyId)) throw new Error("Submitted application ownership and property could not be verified.");
      recordSignupInventory(manager.reservation, { namespace: "application", state: "resolved", actorId: manager.managerId, marker, id: application.data[0]!.id, propertyId, residentActorId: resident.manifest.actorId });
      await shot(guestPage, "07-application-submitted");

      await managerPage.goto("/portal/properties", { waitUntil: "domcontentloaded" });
      await managerPage.goto("/portal/applications");
      await expect(managerPage.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
      await expect(managerPage.getByText(guest.name).first()).toBeVisible({ timeout: 60_000 });
      await shot(managerPage, "08-manager-sees-application");

    } finally {
      try {
        try { if (residentReservation && guestContext) await revokeSignupContext(db, residentReservation.file, guestContext); }
        finally { if (managerReservation) await revokeSignupContext(db, managerReservation.file, managerContext); }
      } finally {
        try { await guestContext?.close(); } finally { await managerContext.close(); }
      }
    }
  });
});
