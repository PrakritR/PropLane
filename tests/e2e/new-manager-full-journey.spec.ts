import { syntheticSignupDomain } from "../helpers/synthetic-signup-domain";
import { navigateToPropertiesAndCapturePlan } from "../helpers/listing-plan-navigation";
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";
import { requestManagerEmailProof, finishManagerEmailProof } from "../helpers/email-onboarding-e2e";
import { completeManagerSignupOnboarding } from "../helpers/manager-onboarding-e2e";
import { clearManagerPhoneGate, type SyntheticPhoneVerification } from "../helpers/synthetic-phone-verification";
import { syntheticFixtureActorId } from "../helpers/synthetic-property-e2e";

/**
 * End-to-end walkthrough: brand-new manager from pricing → account creation →
 * empty portal → first listing draft → every major portal section.
 * Evidence screenshots land in .new-manager-journey/ at repo root.
 */

const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const EVIDENCE_DIR =
  process.env.NEW_MANAGER_EVIDENCE_DIR ??
  path.resolve(__dirname, "../../.new-manager-journey");

function shot(page: import("@playwright/test").Page, name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

const PORTAL_SECTIONS = [
  { name: "dashboard", path: "/portal/dashboard" },
  { name: "properties", path: "/portal/properties" },
  { name: "tours", path: "/portal/tours/pending" },
  { name: "applications", path: "/portal/applications" },
  { name: "leases", path: "/portal/leases" },
  { name: "residents", path: "/portal/residents/current" },
  { name: "payments", path: "/portal/payments" },
  { name: "services", path: "/portal/services/requests" },
  { name: "inbox", path: "/portal/communication/active" },
  { name: "documents", path: "/portal/documents/income-documents" },
  { name: "finances", path: "/portal/financials/income" },
  { name: "promotion", path: "/portal/promotion" },
  { name: "workspaces", path: "/portal/profile?tab=workspaces" },
  { name: "settings", path: "/portal/profile" },
  { name: "feedback", path: "/portal/bugs-feedback" },
] as const;

test.describe("New manager — full journey from scratch", () => {
  test.skip(!hasSupabase, "Requires the dev/test Supabase project");

  test("pricing → signup → portal tour → first listing draft", async ({ page }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    let phoneFixture: SyntheticPhoneVerification | null = null;

    await mockStripeAllRoutes(page);

    try {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") !== "https://emstjswhotsnyksqhqyf.supabase.co") throw new Error("Synthetic signup requires the exact dev/test project.");
    const stamp = Date.now();
    const email = `fresh-manager-${stamp}@${syntheticSignupDomain()}`;
    const fullName = "Fresh Journey Manager";
    const phone = "+12065550199";

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, "signup.json"),
      JSON.stringify({ email, fullName, createdAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    fs.chmodSync(path.join(EVIDENCE_DIR, "signup.json"), 0o600);

    // ── 1. Discover pricing and choose Pro ──────────────────────────────────
    await page.goto("/partner/pricing");
    await shot(page, "01-pricing");
    await Promise.all([
      page.waitForURL(/\/auth\/create-account.*tier=pro/, { timeout: 30_000 }),
      page.locator('[data-attr="pricing-choose-pro"]').click(),
    ]);
    await shot(page, "02-create-account-form");

    // ── 2. Create account, then pick property manager portal ─────────────────
    const verificationHref = await requestManagerEmailProof(page, email, undefined, "pro");
    await shot(page, "03-check-email");
    await finishManagerEmailProof(page, verificationHref, email, fullName, phone, undefined, "pro");
    await shot(page, "03b-account-ready");
    await page.getByRole("button", { name: "Go to portal" }).click();
    await page.waitForURL((url) => url.pathname === "/auth/verify-phone", { timeout: 90_000 });
    // The mandatory phone gate stands between the proven mailbox and the portal. Cleared as
    // FIXTURE SETUP for this one synthetic account and restored afterwards; no OTP is exercised.
    phoneFixture = await clearManagerPhoneGate(page, { email, phone });
    await completeManagerSignupOnboarding(page);
    await page.waitForLoadState("domcontentloaded");
    await shot(page, "04-portal-landing");

    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-attr="manager-properties-add-top"], [data-attr="manager-properties-create"]')).toBeVisible({ timeout: 60_000 });

    // ── 3. Tour every major portal section (fresh empty account) ────────────
    const sectionResults: Array<{ name: string; ok: boolean; note?: string }> = [];
    for (const section of PORTAL_SECTIONS) {
      try {
        await page.goto(section.path, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
        await shot(page, `05-portal-${section.name}`);
        sectionResults.push({ name: section.name, ok: true });
      } catch (err) {
        sectionResults.push({
          name: section.name,
          ok: false,
          note: err instanceof Error ? err.message.slice(0, 120) : String(err),
        });
        await shot(page, `05-portal-${section.name}-FAIL`);
      }
    }
    fs.writeFileSync(path.join(EVIDENCE_DIR, "portal-sections.json"), JSON.stringify(sectionResults, null, 2));

    const failedSections = sectionResults.filter((s) => !s.ok);
    expect(failedSections, `Portal sections that failed: ${JSON.stringify(failedSections)}`).toHaveLength(0);

    // ── 4. Start first listing (Home step + save draft) ─────────────────────
    const { planStatus, planBody: plan } = await navigateToPropertiesAndCapturePlan(page);
    expect(planStatus >= 200 && planStatus < 300, `Manager subscription should resolve before Add (HTTP ${planStatus}).`).toBe(true);
    expect(plan.effectiveTier).toBe("pro");
    expect(plan.planUnknown).toBe(false);
    const createBtn = page.locator('[data-attr="manager-properties-add-top"], [data-attr="manager-properties-create"]');
    await expect(createBtn).toBeEnabled({ timeout: 60_000 });
    await createBtn.click();
    const editor = page.getByRole("dialog", { name: "Listing editor" });
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await shot(page, "06-listing-wizard-open");

    const listingName = `Journey House ${stamp}`;
    await editor.locator('[data-attr="listing-v2-kind-house"]').click();
    await editor.getByPlaceholder("Magnolia House").fill(listingName);
    await editor.getByPlaceholder("142 Ash St").fill("400 Broad St");
    await editor.getByLabel("City").fill("Seattle");
    await editor.getByLabel("State").fill("WA");
    await editor.getByLabel("ZIP").fill("98109");
    await shot(page, "07-listing-home-step");

    const save = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/property-records"
      && (response.request().postData() ?? "").includes(listingName), { timeout: 30_000 });
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    const saved = await save;
    expect(saved.ok()).toBe(true);
    const savedBody = saved.request().postDataJSON() as { id?: unknown };
    expect(typeof savedBody.id).toBe("string");
    expect(savedBody.id).not.toBe("");
    await expect(editor).toBeHidden({ timeout: 45_000 });
    await shot(page, "08-listing-draft-saved");

    const actorId = await syntheticFixtureActorId(page);
    const snapshotResponse = await page.request.get("/api/property-records");
    expect(snapshotResponse.ok()).toBe(true);
    const snapshot = await snapshotResponse.json() as { snapshot?: { sideByUser?: Record<string, { drafts?: Array<{ adminRefId?: string; listingId?: string; buildingName?: string; submission?: { buildingName?: string } }> }> } };
    expect(snapshot.snapshot?.sideByUser?.[actorId]?.drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({ adminRefId: savedBody.id, listingId: savedBody.id, buildingName: listingName, submission: expect.objectContaining({ buildingName: listingName }) }),
    ]));
    await page.goto("/portal/properties/drafts", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(listingName).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "09-drafts-tab-has-listing");

    // ── 5. Settings → Workspaces — team lives here (no Teams page) ──────────
    await page.goto("/portal/profile?tab=workspaces");
    await expect(page.locator('[data-attr="settings-layout"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-attr="settings-nav-workspaces"]')).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-attr="settings-workspace-name"]')).toBeVisible();
    await expect(page.locator('[data-attr="workspace-card"]').first()).toBeVisible();
    await shot(page, "10-workspaces-team");

    console.log("NEW MANAGER JOURNEY OK");
    console.log(`Evidence: ${EVIDENCE_DIR}`);
    } finally {
      // Always, including on failure: the synthetic phone stamp goes back, and a conflict is
      // reported rather than left behind.
      await phoneFixture?.restore();
    }
  });
});
