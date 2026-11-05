import { test, expect, type Page } from "@playwright/test";
import { signInAsAdmin, signInAsManager, signInAsResident } from "../helpers/auth";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

/** Retain a dark preference before bootstrap so the light-only gate is exercised. */
async function saveDarkPreference(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("axis:theme", "dark");
  });
}

/** The product intentionally keeps the saved preference inert while dark mode is disabled. */
async function assertStoredDarkPreferenceIsInert(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("axis:theme"))).toBe("dark");
  await expect(page.getByRole("group", { name: "Theme", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Dark theme", exact: true })).toHaveCount(0);
  await expect(page.getByText("Appearance", { exact: true })).toHaveCount(0);
}

test.describe("Public marketing — light theme only", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("axis:theme", "dark");
    });
  });

  test("marketing home stays light even when dark is saved", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await assertStoredDarkPreferenceIsInert(page);
  });

  test("partner page stays light", async ({ page }) => {
    await page.goto("/partner");
    await assertStoredDarkPreferenceIsInert(page);
  });
});

test.describe("Light-only policy — auth surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await saveDarkPreference(page);
  });

  test("auth sign-in keeps stored dark inert after navigation and reload", async ({ page }) => {
    await page.goto("/auth/sign-in");
    // The unified auth hub (NativeAuthHub) renders no heading and placeholder-only
    // inputs, inside a blend AuthCard (`.auth-card`, no `.glass-card`).
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await expect(page.locator(".auth-card").first()).toBeVisible();
    await assertStoredDarkPreferenceIsInert(page);
    await page.reload();
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await assertStoredDarkPreferenceIsInert(page);
  });

  test("auth create-account keeps stored dark inert", async ({ page }) => {
    await page.goto("/auth/create-account");
    // PRP-307: the bare create surface is the role chooser, not a form — the
    // fields live behind Property / Resident / Vendor.
    await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^property/i })).toBeVisible();
    await assertStoredDarkPreferenceIsInert(page);
  });
});

test.describe("Light-only policy — property portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await saveDarkPreference(page);
    await signInAsManager(page);
  });

  const routes = [
    "/portal/dashboard",
    "/portal/properties",
    "/portal/applications",
    "/portal/calendar/tours",
    "/portal/profile",
  ] as const;

  for (const route of routes) {
    test(`${route} keeps stored dark inert and hides Appearance`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertStoredDarkPreferenceIsInert(page);
    });
  }
});

test.describe("Light-only policy — resident portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await saveDarkPreference(page);
    await signInAsResident(page);
  });

  const routes = ["/resident/dashboard", "/resident/lease", "/resident/payments"] as const;

  for (const route of routes) {
    test(`${route} keeps stored dark inert and hides Appearance`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertStoredDarkPreferenceIsInert(page);
    });
  }
});

test.describe("Light-only policy — admin portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await saveDarkPreference(page);
    await signInAsAdmin(page);
  });

  const routes = ["/admin/dashboard", "/admin/service", "/admin/axis-users", "/admin/events", "/admin/communication/inbox/unopened"] as const;

  for (const route of routes) {
    test(`${route} keeps stored dark inert and hides Appearance`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertStoredDarkPreferenceIsInert(page);
    });
  }
});
