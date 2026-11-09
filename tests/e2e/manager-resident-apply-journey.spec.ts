import { syntheticSignupDomain } from "../helpers/synthetic-signup-domain";
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mockStripeAllRoutes } from "../helpers/auth";
import { requestManagerEmailProof, finishManagerEmailProof, requestResidentEmailProof, finishResidentEmailProof } from "../helpers/email-onboarding-e2e";
import { verifySyntheticManagerPhone, verifySyntheticResidentPhone, type SyntheticPhoneVerification, withSyntheticPhoneFixtureOwnership } from "../helpers/synthetic-phone-verification";
import {
  completeManagerSignupOnboarding,
} from "../helpers/manager-onboarding-e2e";
import { visibleLocator, fillCurrentRentalApplication } from "../helpers/rental-wizard-e2e";
import { fillSyntheticListingBasics } from "../helpers/listing-editor-e2e";
import { syntheticFixtureActorId } from "../helpers/synthetic-property-e2e";
import { navigateToPropertiesAndReadPlan } from "../helpers/listing-plan-navigation";

/**
 * Browser E2E: brand-new manager → publish first listing → verified resident applies
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

const EVIDENCE_DIR = path.join(process.env.E2E_PRIVATE_FIXTURE_DIR ?? "/nonexistent-private-fixture", `manager-resident-${randomUUID()}`);

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

async function createFreshManager(page: Page, stamp: number) {
  const email = `e2e-manager-${stamp}@${syntheticSignupDomain()}`;
  const fullName = "E2E Journey Manager";
  const phone = `+1206555${String(stamp % 10_000).padStart(4, "0")}`;

  await page.goto("/partner/pricing");
  await shot(page, "01-pricing");
  // The exact Pro CTA on `/partner/pricing`, which is `ManagerStartPage`: a broad name match
  // took the FIRST matching control, which is the Free card, and every tier assertion
  // downstream then read a free-tier signup. `pricing-plan-*-cta` belongs to the marketing
  // pricing cards and is not on this page.
  await Promise.all([
    page.waitForURL(/\/auth\/create-account\?.*\btier=pro\b/, { timeout: 30_000 }),
    page.locator('[data-attr="pricing-choose-pro"]').click(),
  ]);

  const verificationHref = await requestManagerEmailProof(page, email, undefined, "pro");
  await shot(page, "02-check-email");
  await finishManagerEmailProof(page, verificationHref, email, fullName, phone, undefined, "pro");
  await shot(page, "02b-account-ready");
  await page.getByRole("button", { name: "Go to portal" }).click();
  await page.waitForURL(/\/auth\/(verify-phone|get-started|manager\/choose-plan|connect-google-services)|\/portal/, { timeout: 90_000 });
  // The mandatory phone gate stands between the proven mailbox and the portal. Cleared as
  // FIXTURE SETUP for this one synthetic account and restored afterwards; no OTP is exercised,
  // and nothing here claims phone verification was tested.
  const phoneFixture = await verifySyntheticManagerPhone(page, { email, phone });
  const ownedSetup = await withSyntheticPhoneFixtureOwnership(phoneFixture, async () => {
    await page.goto("/portal/dashboard", { waitUntil: "domcontentloaded" });
    await completeManagerSignupOnboarding(page);
    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-attr="manager-properties-add-top"], [data-attr="manager-properties-create"]')).toBeVisible({ timeout: 60_000 });
    await shot(page, "03-manager-portal");
  });
  return { email, fullName, phone, phoneFixture: ownedSetup.fixture };
}

async function publishFirstListing(page: Page, stamp: number): Promise<string> {
  const { planStatus, planBody: initialPlan } = await navigateToPropertiesAndReadPlan(page);
  if (planStatus < 200 || planStatus >= 300) throw new Error(`Could not resolve the manager subscription before Add (HTTP ${planStatus}).`);
  if (initialPlan.effectiveTier !== "pro" || initialPlan.planUnknown !== false) throw new Error("The listing editor requires a resolved Pro subscription before Add.");
  const createBtn = page.locator('[data-attr="manager-properties-add-top"], [data-attr="manager-properties-create"]');
  await expect(createBtn).toBeEnabled({ timeout: 60_000 });
  await createBtn.click();
  const editor = page.getByRole("dialog", { name: "Listing editor" });
  await expect(editor).toBeVisible({ timeout: 20_000 });

  const buildingName = `E2E House ${stamp}`;
  await fillSyntheticListingBasics(editor, buildingName);
  const longTerm = editor.locator('[data-attr="listing-v2-stay-long-term"]');
  await expect(longTerm).toHaveAttribute("aria-checked", "true");
  await shot(page, "04-listing-home");

  await editor.locator('[data-attr="listing-v2-rail-review"]').click();
  const publish = editor.locator('[data-attr="listing-v2-publish"]');
  await expect(publish).toBeVisible();
  await publish.click();
  const setRent = editor.locator('[data-attr="listing-v2-open-pricing"]');
  await expect(setRent, "the current listing flow should direct a missing rent to its Pricing page").toBeVisible();
  await shot(page, "05-listing-review-rent-required");
  await setRent.click();

  await expect(page.locator('[data-attr="property-pricing"]')).toBeVisible({ timeout: 30_000 });
  const pricingUrl = new URL(page.url());
  const draftMatch = pricingUrl.pathname.match(/\/portal\/properties\/drafts\/([^/]+)\/pricing$/);
  if (!draftMatch) throw new Error("The missing-rent action did not open the exact synthetic draft's Pricing tab.");
  const propertyId = decodeURIComponent(draftMatch[1]!);
  await page.locator('[data-attr="property-pricing-tab-whole"]').click();
  await page.locator('[data-attr="property-pricing-add"]').click();
  const wholeHouseRent = page.getByRole("textbox", { name: "Whole house rent", exact: true });
  await expect(wholeHouseRent).toBeVisible();
  await wholeHouseRent.fill("1800");
  const savePricing = page.locator('[data-attr="property-room-pricing-save"]');
  const saveResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/property-records", { timeout: 60_000 });
  await savePricing.click();
  const pricingSavedResponse = await saveResponse;
  if (!pricingSavedResponse.ok()) throw new Error(`Saving synthetic whole-house pricing failed (${pricingSavedResponse.status()}).`);
  await expect(page.getByText("Pricing saved.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-attr="property-room-pricing-save"]')).toHaveCount(0, { timeout: 15_000 });

  const managerId = await syntheticFixtureActorId(page);
  const pricedDraft = await db.from("manager_property_records").select("id,manager_user_id,status,row_data,property_data").eq("id", propertyId).eq("manager_user_id", managerId).single();
  const draftRow = pricedDraft.data?.row_data as { submission?: { buildingName?: unknown; entireHomeMonthlyRent?: unknown } } | null;
  if (
    pricedDraft.error ||
    pricedDraft.data?.id !== propertyId ||
    pricedDraft.data?.manager_user_id !== managerId ||
    pricedDraft.data?.status !== "draft" ||
    pricedDraft.data?.property_data !== null ||
    draftRow?.submission?.buildingName !== buildingName ||
    draftRow?.submission?.entireHomeMonthlyRent !== 1800
  ) {
    throw new Error("The exact draft did not persist its whole-house rent through the Pricing UI.");
  }

  const draftPreviewPath = pricingUrl.pathname.replace(/\/pricing$/, "/preview");
  const { planStatus: reopenPlanStatus, planBody: reopenPlan } = await navigateToPropertiesAndReadPlan(page, draftPreviewPath);
  if (reopenPlanStatus < 200 || reopenPlanStatus >= 300) throw new Error(`Could not resolve the manager subscription before reopening the draft (HTTP ${reopenPlanStatus}).`);
  if (reopenPlan.effectiveTier !== "pro" || reopenPlan.planUnknown !== false) throw new Error("The draft editor cannot reopen before the Pro subscription is resolved.");
  await visibleLocator(page, '[data-attr="draft-continue-editing"]').click();
  const resumedEditor = page.getByRole("dialog", { name: "Listing editor" });
  await expect(resumedEditor).toBeVisible({ timeout: 20_000 });
  await resumedEditor.locator('[data-attr="listing-v2-rail-review"]').click();
  await shot(page, "06-listing-review-priced");
  const publishResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/property-records", { timeout: 60_000 });
  await resumedEditor.locator('[data-attr="listing-v2-publish"]').click();
  const publishedResponse = await publishResponse;
  if (!publishedResponse.ok()) throw new Error(`Publishing the exact synthetic listing failed (${publishedResponse.status()}).`);
  await expect(page.locator('[data-attr="listing-published-dialog"]')).toBeVisible({ timeout: 45_000 });
  await shot(page, "06-listing-live");

  await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(buildingName).first()).toBeVisible({ timeout: 30_000 });

  const { data: listing, error } = await db
    .from("manager_property_records")
    .select("id,manager_user_id,status,row_data,property_data")
    .eq("manager_user_id", managerId)
    .eq("id", propertyId)
    .single();
  if (error) throw error;
  const saved = listing.property_data as { listingSubmission?: { buildingName?: unknown; entireHomeMonthlyRent?: unknown } } | null;
  if (
    listing.id !== propertyId ||
    listing.manager_user_id !== managerId ||
    listing.status !== "live" ||
    saved?.listingSubmission?.buildingName !== buildingName ||
    saved?.listingSubmission?.entireHomeMonthlyRent !== 1800
  ) {
    throw new Error("The exact synthetic listing was not confirmed live with its persisted whole-house rent.");
  }
  return propertyId;
}

test.describe.configure({ mode: "serial", timeout: 600_000 });

test.describe("Manager signup → listing → resident apply", () => {
  test.skip(!hasSupabase, "Requires dev/test Supabase env (.env.local)");

  test("new manager publishes a listing and receives a verified resident application", async ({ browser }) => {
    test.setTimeout(600_000);
    if (process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") !== "https://emstjswhotsnyksqhqyf.supabase.co") throw new Error("Synthetic signup requires the exact dev/test project.");
    const stamp = Date.now();
    const guest = {
      name: "Jordan Applicant",
      email: `e2e-applicant-${stamp}@${syntheticSignupDomain()}`,
      phone: `+1206555${String((stamp + 1) % 10_000).padStart(4, "0")}`,
    };

    const base = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://invalid");
    const port = Number(base.port);
    if (base.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(base.hostname) || !Number.isInteger(port) || port < 3000 || port > 3014) throw new Error("Synthetic journey requires localhost.");
    const fixtureDir = process.env.E2E_PRIVATE_FIXTURE_DIR;
    if (!fixtureDir || !path.isAbsolute(fixtureDir)) throw new Error("Private synthetic fixture directory required.");
    const stat = fs.lstatSync(fixtureDir);
    const followed = fs.statSync(fixtureDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(fixtureDir) !== fixtureDir || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || followed.ino !== stat.ino || followed.dev !== stat.dev) throw new Error("Synthetic fixture directory must be private and owned.");
    const managerEmail = `e2e-manager-${stamp}@${syntheticSignupDomain()}`;
    const managerPhone = `+1206555${String(stamp % 10_000).padStart(4, "0")}`;
    const manifestPath = path.join(fixtureDir, `manager-resident-journey-${randomUUID()}.json`);
    const manifest: Record<string, unknown> = { managerEmail, residentEmail: guest.email, state: "reserved", retained: true };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    const saveManifest = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    for (let page = 1; page <= 100; page += 1) {
      const users = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (users.error || users.data.users.some((user) => [managerEmail, guest.email].includes(user.email?.toLowerCase() ?? "") || [managerPhone, guest.phone].includes(user.phone ?? ""))) throw new Error("Synthetic journey identity reservation failed.");
      if (users.data.users.length < 1000) break;
      if (page === 100) throw new Error("Synthetic mailbox reservation exceeded its bound.");
    }
    for (const email of [managerEmail, guest.email]) {
      const [profile, application] = await Promise.all([db.from("profiles").select("id").eq("email", email).limit(1), db.from("manager_application_records").select("id").eq("resident_email", email).limit(1)]);
      if (profile.error || application.error || profile.data?.length || application.data?.length) throw new Error("Synthetic journey mailbox is already in use.");
    }
    for (const phone of [managerPhone, guest.phone]) {
      const profiles = await db.from("profiles").select("id").eq("phone", phone).limit(1);
      if (profiles.error || profiles.data?.length) throw new Error("Synthetic journey phone is already in use or unreadable.");
    }

    fs.mkdirSync(EVIDENCE_DIR, { mode: 0o700 });

    const managerContext = await browser.newContext({ viewport: DESKTOP, storageState: { cookies: [], origins: [] } });
    const managerPage = await managerContext.newPage();
    managerPage.setDefaultTimeout(30_000);
    await mockStripeAllRoutes(managerPage);

    let phoneFixture: SyntheticPhoneVerification | null = null;
    let guestContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;
    let residentPhoneFixture: SyntheticPhoneVerification | null = null;
    try {
      const manager = await createFreshManager(managerPage, stamp);
      phoneFixture = manager.phoneFixture;
      const managerId = await syntheticFixtureActorId(managerPage);
      Object.assign(manifest, { managerId, state: "manager-created" }); saveManifest();
      const settings = await db.from("manager_automation_settings").select("row_data,updated_at").eq("manager_user_id", managerId).maybeSingle();
      if (settings.error) throw new Error("Could not read the exact synthetic manager fee settings.");
      Object.assign(manifest, { feeSettingsBefore: settings.data ?? null }); saveManifest();
      const priorSettings = (settings.data?.row_data ?? {}) as Record<string, unknown>;
      const priorApplicationSettings = (priorSettings.applicationSettings ?? {}) as Record<string, unknown>;
      const feeRow = { row_data: { ...priorSettings, applicationSettings: { ...priorApplicationSettings, applicationFeeCents: 0 } }, updated_at: new Date().toISOString() };
      if (settings.data && !settings.data.updated_at) throw new Error("Synthetic fee settings lack a revision.");
      const feeWrite = settings.data
        ? await db.from("manager_automation_settings").update(feeRow).eq("manager_user_id", managerId).eq("updated_at", settings.data.updated_at).select("manager_user_id")
        : await db.from("manager_automation_settings").insert({ manager_user_id: managerId, ...feeRow }).select("manager_user_id");
      if (feeWrite.error || feeWrite.data?.length !== 1) throw new Error("Could not configure the exact synthetic manager fee.");
      const feeRead = await db.from("manager_automation_settings").select("row_data,updated_at").eq("manager_user_id", managerId).single();
      if (feeRead.error || (feeRead.data?.row_data as { applicationSettings?: { applicationFeeCents?: unknown } })?.applicationSettings?.applicationFeeCents !== 0) throw new Error("Synthetic fee settings were not confirmed.");
      Object.assign(manifest, { feeSettingsAfter: feeRead.data }); saveManifest();
      const propertyId = await publishFirstListing(managerPage, stamp);
      Object.assign(manifest, { propertyId, state: "listing-created" }); saveManifest();
      const feeResponse = await managerPage.request.post("/api/public/application-fee-preview", { data: { propertyId, rentalType: "standard", leaseTerm: "Long-term" } });
      const fee = await feeResponse.json() as { applicationFeeCents?: unknown; totalCents?: unknown };
      if (!feeResponse.ok() || fee.applicationFeeCents !== 0 || fee.totalCents !== 0) throw new Error("Synthetic listing must have a real zero application fee.");
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "run.json"),
        JSON.stringify({ email: manager.email, fullName: manager.fullName, phone: manager.phone,
          propertyId, guest, createdAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
      fs.chmodSync(path.join(EVIDENCE_DIR, "run.json"), 0o600);

      guestContext = await browser.newContext({ viewport: DESKTOP, storageState: { cookies: [], origins: [] } });
      const guestPage = await guestContext.newPage();
      guestPage.setDefaultTimeout(30_000);
      await mockStripeAllRoutes(guestPage);
      await guestPage.goto(`/rent/apply?propertyId=${encodeURIComponent(propertyId)}`);
      const createAccount = guestPage.locator('[data-attr="public-apply-create-account"]').filter({ visible: true });
      await expect(createAccount).toBeVisible({ timeout: 45_000 });
      await expect(guestPage.locator('[data-attr="public-apply-continue-guest"]')).toHaveCount(0);
      await createAccount.click();
      const href = await requestResidentEmailProof(guestPage, guest.email, propertyId);
      expect(await finishResidentEmailProof(guestPage, href, guest.email, guest.name, guest.phone)).toBe(200);
      const residentId = await syntheticFixtureActorId(guestPage);
      Object.assign(manifest, { residentId, state: "resident-created" }); saveManifest();
      const auth = await db.auth.admin.getUserById(residentId);
      const roles = await db.from("profile_roles").select("role").eq("user_id", residentId);
      if (auth.error || auth.data.user?.email !== guest.email || !auth.data.user.email_confirmed_at || roles.error || !roles.data?.some((r) => r.role === "resident") || roles.data.some((r) => r.role !== "resident")) throw new Error("Synthetic resident identity was not verified.");
      residentPhoneFixture = await verifySyntheticResidentPhone(guestPage, { email: guest.email, phone: guest.phone });
      await guestPage.goto(`/rent/apply?propertyId=${encodeURIComponent(propertyId)}`);
      await expect(visibleLocator(guestPage, '[data-wizard-field="applyingAsGroup"]')).toBeVisible({ timeout: 45_000 });
      const submitted = guestPage.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/manager-applications", { timeout: 60_000 });
      await fillCurrentRentalApplication(guestPage, guest, { kind: "solo" });
      if (!(await submitted).ok()) throw new Error("Verified resident application submission failed.");
      let confirmedApplication: { id: string; updated_at: string } | null = null;
      await expect.poll(async () => {
        const rows = await db.from("manager_application_records").select("id,manager_user_id,property_id,resident_email,row_data,updated_at").eq("resident_email", guest.email).eq("property_id", propertyId).limit(2);
        if (rows.error || rows.data?.length !== 1) return false;
        const app = rows.data[0]!;
        const data = app.row_data as { residentUserId?: string; stage?: string; bucket?: string };
        if (app.manager_user_id !== managerId || data.residentUserId !== residentId || data.bucket !== "pending" || !data.stage || data.stage === "In progress") return false;
        confirmedApplication = { id: app.id, updated_at: app.updated_at };
        return true;
      }, { timeout: 60_000 }).toBe(true);
      Object.assign(manifest, { application: confirmedApplication, state: "application-confirmed" }); saveManifest();
      await shot(guestPage, "07-application-submitted");

      await managerPage.goto("/portal/properties", { waitUntil: "domcontentloaded" });
      await managerPage.goto("/portal/applications");
      await expect(managerPage.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
      await expect(managerPage.getByText(guest.name).first()).toBeVisible({ timeout: 60_000 });
      await shot(managerPage, "08-manager-sees-application");
    } finally {
      // Always, including on failure: the synthetic phone stamp goes back, and a conflict is
      // reported rather than left behind.
      const failures: unknown[] = [];
      try { await residentPhoneFixture?.restore(); } catch (error) { failures.push(error); }
      try { await phoneFixture?.restore(); } catch (error) { failures.push(error); }
      await managerContext.close();
      await guestContext?.close();
      if (failures.length) {
        Object.assign(manifest, { phoneRestoreFailed: true }); saveManifest();
        throw new AggregateError(failures, "Synthetic phone fixture restoration failed.");
      }
    }
  });
});
