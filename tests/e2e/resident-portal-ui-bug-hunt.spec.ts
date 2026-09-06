import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { mockStripeCheckoutRoutes } from "../helpers/auth";
import { pathToUrlRegExp } from "../helpers/url-match";
import { RESIDENT_PORTAL_SMOKE_PATHS } from "@/lib/portals/resident-sections";

/**
 * Resident portal UI bug hunt — automated half of proplane-portal-bug-hunt skill.
 *
 * Run:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 \
 *     E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/resident-portal-ui-bug-hunt.spec.ts
 */

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 800 };

test.use({ storageState: path.join(__dirname, "../.auth/resident.json") });

async function gotoTolerantly(page: Page, route: string) {
  try {
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) throw error;
  }
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 2;
  });
  expect(overflow, `horizontal overflow on ${label}`).toBe(false);
}

test.describe("Resident portal UI bug hunt", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeCheckoutRoutes(page);
  });

  test("desktop: smoke paths render without horizontal overflow", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(DESKTOP);

    const overflowing: string[] = [];
    for (const { path: route, label } of RESIDENT_PORTAL_SMOKE_PATHS) {
      await gotoTolerantly(page, route);
      await expect(page.getByRole("heading").first().or(page.locator("main")).first()).toBeVisible({
        timeout: 25_000,
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      if (overflow) overflowing.push(`${label} (${route})`);
    }
    expect(overflowing, `horizontal overflow on: ${overflowing.join(", ")}`).toEqual([]);
  });

  test("mobile native: smoke paths render without horizontal overflow", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(MOBILE);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });

    const overflowing: string[] = [];
    for (const { path: route, label } of RESIDENT_PORTAL_SMOKE_PATHS) {
      await gotoTolerantly(page, route);
      await expect(page.getByRole("heading").first().or(page.locator("main")).first()).toBeVisible({
        timeout: 25_000,
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      if (overflow) overflowing.push(`${label} (${route})`);
    }
    expect(overflowing, `horizontal overflow on: ${overflowing.join(", ")}`).toEqual([]);
  });

  test("narrow mobile: payments and communication do not overflow", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(NARROW);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });

    for (const route of ["/resident/payments", "/resident/communication/active", "/resident/services"]) {
      await gotoTolerantly(page, route);
      await expect(page.getByRole("heading").first().or(page.locator("main")).first()).toBeVisible({
        timeout: 25_000,
      });
      await assertNoHorizontalOverflow(page, route);
    }
  });

  test("mobile: bottom nav tabs are tappable within viewport", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });
    await gotoTolerantly(page, "/resident/dashboard");

    const tabs = page.locator('[data-attr^="bottom-nav-"]');
    await expect(tabs.first()).toBeVisible({ timeout: 25_000 });

    const unreachable: string[] = [];
    for (let i = 0; i < (await tabs.count()); i++) {
      const name = (await tabs.nth(i).getAttribute("data-attr")) ?? `tab-${i}`;
      const box = await tabs.nth(i).boundingBox();
      if (!box) {
        unreachable.push(`${name} (not laid out)`);
        continue;
      }
      if (box.y + box.height > MOBILE.height + 2) unreachable.push(`${name} (below fold)`);
      if (box.x < -2 || box.x + box.width > MOBILE.width + 2) unreachable.push(`${name} (off side)`);
      if (box.height < 40 || box.width < 40) {
        unreachable.push(`${name} (${Math.round(box.width)}x${Math.round(box.height)} tap target)`);
      }
    }
    expect(unreachable, `unreachable bottom-nav tabs: ${unreachable.join(", ")}`).toEqual([]);
  });

  test("mobile: portal main reserves bottom inset on native", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });
    await gotoTolerantly(page, "/resident/dashboard");
    await expect(page.locator("#portal-main-content")).toBeVisible({ timeout: 25_000 });

    const inset = await page.evaluate(() => {
      const main = document.getElementById("portal-main-content");
      if (!main) return null;
      return getComputedStyle(main).paddingBottom;
    });
    expect(inset, "native shell should reserve bottom inset on main content").toBeTruthy();
    expect(inset).not.toBe("0px");
  });

  test("legacy finances redirect lands on payments", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoTolerantly(page, "/resident/finances/summary");
    await expect(page).toHaveURL(/\/resident\/payments/, { timeout: 15_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
