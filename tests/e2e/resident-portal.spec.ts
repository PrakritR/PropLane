import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";
import { mockStripeCheckoutRoutes, signInAsResident } from "../helpers/auth";
import { gotoAppPath, pathToUrlRegExp } from "../helpers/url-match";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";
const UNSIGNED_M2_APP_ID = "AXIS-QA-LIFECYCLE-1108-M2";
const UNSIGNED_M2_PROPERTY_ID = "qa-lifecycle-1108-manager2-house";
const UNSIGNED_LOCK_TESTS = new Set([
  "services stays locked until the approved resident signs a lease",
  "legacy services sub-paths preserve the signed-lease stage guard",
  "my home stays locked until the approved resident signs a lease",
]);

test.use({ storageState: path.join(__dirname, "../.auth/resident.json") });

const PRE_LEASE_RESIDENT_SECTIONS = [
  { label: "Dashboard", path: "/resident/dashboard" },
  { label: "Tour", path: "/resident/tour" },
  { label: "Applications", path: "/resident/applications" },
  { label: "Lease", path: "/resident/lease" },
  { label: "Payments", path: "/resident/payments" },
  { label: "Communication", path: "/resident/communication/active" },
  { label: "Documents", path: "/resident/documents/application", canonicalPath: "/resident/documents/to-sign", kind: "application" },
] as const;

async function expectSignedLeaseLock(page: import("@playwright/test").Page, label: string) {
  await expect(page).toHaveURL(/\/resident\/dashboard\/?$/, { timeout: 15_000 });
  await expect(
    page.getByRole("link", {
      name: new RegExp(`${label}: Available after your lease is signed`, "i"),
    }),
  ).toBeVisible();
}

function assertLocalDevTarget(baseURL: string): string {
  if (!baseURL || process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://emstjswhotsnyksqhqyf.supabase.co") {
    throw new Error("Unsigned-resident E2E requires the DEV database and localhost.");
  }
  const url = new URL(baseURL);
  const port = Number(url.port);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !Number.isInteger(port) || port < 3000 || port > 3014) {
    throw new Error("Unsigned-resident E2E requires a localhost port from 3000 through 3014.");
  }
  return baseURL;
}

async function openUnsignedResidentStage(browser: Browser, configuredPage: Page): Promise<{ context: BrowserContext | null; page: Page }> {
  const configuredBase = process.env.PLAYWRIGHT_BASE_URL || (configuredPage.url().startsWith("http") ? new URL(configuredPage.url()).origin : "");
  const baseURL = assertLocalDevTarget(configuredBase);
  const storageState = process.env.E2E_UNSIGNED_RESIDENT_STORAGE_STATE;
  if (storageState && !path.isAbsolute(storageState)) throw new Error("Unsigned-resident storage state must use an absolute private path.");
  const context = storageState ? await browser.newContext({ baseURL, storageState }) : null;
  const page = context ? await context.newPage() : configuredPage;
  const response = await page.request.get("/api/manager-applications?scope=self");
  if (!response.ok()) {
    await context?.close();
    throw new Error(`Unsigned-resident fixture preflight failed (HTTP ${response.status()}).`);
  }
  const body = await response.json() as { rows?: Array<{ id?: string; bucket?: string; propertyId?: string }> };
  const applications = (body.rows ?? []).filter((row) => row.bucket === "approved");
  if (storageState) {
    const application = applications.find((row) => row.id === UNSIGNED_M2_APP_ID);
    if (!application || application.propertyId !== UNSIGNED_M2_PROPERTY_ID) {
      await context?.close();
      throw new Error("Unsigned-resident fixture is not bound to its approved M2 application/property.");
    }
  } else if (applications.length === 0) {
    throw new Error("Configured resident auth has no approved application; it cannot prove the unsigned-resident stage.");
  }
  // Preflight the actual stage before each target assertion. A signed resident
  // must fail here rather than being mislabeled as an unsigned fixture.
  await page.goto("/resident/services");
  await expectSignedLeaseLock(page, "Services");
  return { context, page };
}

test.describe("Resident portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }, testInfo) => {
    if (UNSIGNED_LOCK_TESTS.has(testInfo.title) && process.env.E2E_UNSIGNED_RESIDENT_STORAGE_STATE) return;
    await mockStripeCheckoutRoutes(page);
    await signInAsResident(page);
  });

  test("dashboard loads", async ({ page }) => {
    await page.goto("/resident/dashboard");
    await expect(page).toHaveURL(/\/resident\/dashboard/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("payments section loads", async ({ page }) => {
    await page.goto("/resident/payments");
    await expect(page).toHaveURL(/\/resident\/payments/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("all pre-lease resident sections load via direct navigation", async ({ page }) => {
    test.setTimeout(180_000);
    for (const section of PRE_LEASE_RESIDENT_SECTIONS) {
      const { path } = section;
      try {
        await gotoAppPath(page, path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Session expired")) throw error;
        await page.goto("/resident/dashboard", { waitUntil: "domcontentloaded" });
        await gotoAppPath(page, path);
      }
      if ("canonicalPath" in section) {
        await expect(page).toHaveURL((url) => url.pathname === section.canonicalPath && url.searchParams.get("kind") === section.kind);
      } else {
        await expect(page).toHaveURL(pathToUrlRegExp(path));
      }
      await expect(page.getByRole("heading").first().or(page.locator("main")).first()).toBeVisible({
        timeout: 30_000,
      });
    }
  });

  test("dashboard shows application status indicator", async ({ page }) => {
    await page.goto("/resident/dashboard");
    // Should show some status indicator (approved/active or checklist)
    const statusEl = page.getByText(/approved|active|welcome|dashboard/i).first();
    await expect(statusEl).toBeVisible({ timeout: 10_000 });
  });

  test("inbox tab loads and compose modal can be opened", async ({ page }) => {
    await page.goto("/resident/communication/active");
    await expect(page.getByRole("heading").first()).toBeVisible();
    const composeBtn = page.getByRole("button", { name: /new message|compose/i }).first();
    if (await composeBtn.count() > 0) {
      await composeBtn.click();
      await expect(
        page.locator("#communication-compose-subject").or(page.getByPlaceholder("Subject")),
      ).toBeVisible({ timeout: 8_000 });
      const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
      if (await cancelBtn.count() > 0) {
        await cancelBtn.click();
      } else {
        await page.keyboard.press("Escape");
      }
    }
  });

  test("services stays locked until the approved resident signs a lease", async ({ browser, page: configuredPage }) => {
    const { context, page } = await openUnsignedResidentStage(browser, configuredPage);
    try {
      await page.goto("/resident/services");
      await expectSignedLeaseLock(page, "Services");
    } finally {
      await context?.close();
    }
  });

  test("legacy services sub-paths preserve the signed-lease stage guard", async ({ browser, page: configuredPage }) => {
    const { context, page } = await openUnsignedResidentStage(browser, configuredPage);
    try {
      await page.goto("/resident/services/requests");
      await expectSignedLeaseLock(page, "Services");
    } finally {
      await context?.close();
    }
  });

  test("documents receipts tab loads", async ({ page }) => {
    await page.goto("/resident/documents/receipts");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("legacy finances path redirects to payments", async ({ page }) => {
    await page.goto("/resident/finances/summary");
    await expect(page).toHaveURL(/\/resident\/payments/, { timeout: 15_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("my home stays locked until the approved resident signs a lease", async ({ browser, page: configuredPage }) => {
    const { context, page } = await openUnsignedResidentStage(browser, configuredPage);
    try {
      await page.goto("/resident/move-in");
      await expectSignedLeaseLock(page, "My home");
    } finally {
      await context?.close();
    }
  });
});
