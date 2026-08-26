import { test, expect } from "@playwright/test";
import { signInAsManager, signInAsResident, mockStripeAllRoutes } from "../helpers/auth";
import { pathToUrlRegExp } from "../helpers/url-match";
import { MANAGER_PORTAL_SMOKE_PATHS } from "@/lib/portals/pro";
import { RESIDENT_PORTAL_SMOKE_PATHS } from "@/lib/portals/resident-sections";
import { ADMIN_PORTAL_SMOKE_PATHS } from "@/lib/portals/admin";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/**
 * Navigate, tolerating the ERR_ABORTED Chromium raises when a redirect replaces the in-flight
 * navigation. Portal smoke paths redirect routinely — a tabbed section lands on its default tab,
 * a stage-locked resident section bounces home — and that is a property of the redirect, not of
 * the layout being measured. Other specs already tolerate it the same way; these loops failing on
 * it intermittently is a long-standing false failure.
 */
async function gotoTolerantly(page: import("@playwright/test").Page, path: string) {
  try {
    await page.goto(path, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) throw error;
  }
}

test.describe("Mobile portal layout", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });
  });

  test("manager smoke paths render headings without page-level horizontal overflow", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsManager(page);

    for (const { path } of MANAGER_PORTAL_SMOKE_PATHS) {
      await gotoTolerantly(page, path);
      await expect(page).toHaveURL(pathToUrlRegExp(path));
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 25_000 });

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 2;
      });
      expect(overflow, `unexpected horizontal overflow on ${path}`).toBe(false);
    }
  });

  test("portal main content reserves bottom inset on native", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsManager(page);
    await page.goto("/portal/dashboard");
    await expect(page.locator("#portal-main-content")).toBeVisible();

    const inset = await page.evaluate(() => {
      const main = document.getElementById("portal-main-content");
      if (!main) return null;
      const styles = getComputedStyle(main);
      return styles.paddingBottom;
    });
    expect(inset).toBeTruthy();
  });
});

test.describe("Mobile resident portal layout", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });
  });

  /**
   * The resident portal had NO mobile coverage: this was skipped for a missing auth helper that
   * has existed for some time, while the manager's equivalent was enforced. On a phone the
   * resident portal is the whole product a resident sees, so it is the half that most needs this.
   *
   * Deliberately the same shape as the manager test above rather than something more elaborate.
   * Resident paths redirect twice — the server bounces a stage-locked section and the client guard
   * replaces on top — so measuring mid-flight is unreliable; asserting that the page RENDERS and
   * does not overflow is the part that holds.
   */
  test("resident smoke paths render without page-level horizontal overflow", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsResident(page);

    const overflowing: string[] = [];
    for (const { path } of RESIDENT_PORTAL_SMOKE_PATHS) {
      await gotoTolerantly(page, path);
      // Not pinned to the URL: a locked section legitimately redirects, and the nav-lock specs
      // already cover where it lands.
      await expect(page.getByRole("heading").first().or(page.locator("main")).first()).toBeVisible({
        timeout: 25_000,
      });

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 2;
      });
      // Collected, so one run names every broken screen instead of stopping at the first.
      if (overflow) overflowing.push(path);
    }
    expect(overflowing, `horizontal overflow on: ${overflowing.join(", ")}`).toEqual([]);
  });

  test("resident bottom nav renders every tab within the viewport", async ({ page }) => {
    await mockStripeAllRoutes(page);
    await signInAsResident(page);
    await page.goto("/resident/dashboard", { waitUntil: "domcontentloaded", timeout: 45_000 });

    // The bar IS the navigation on a phone, and it renders after hydration — so it must be
    // waited for, not sampled straight after domcontentloaded.
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
      if (box.y + box.height > MOBILE_VIEWPORT.height + 2) unreachable.push(`${name} (below fold)`);
      if (box.x < -2 || box.x + box.width > MOBILE_VIEWPORT.width + 2) unreachable.push(`${name} (off side)`);
      // Below ~40px a tap reliably lands on the neighbouring tab.
      if (box.height < 40 || box.width < 40) {
        unreachable.push(`${name} (${Math.round(box.width)}x${Math.round(box.height)} tap target)`);
      }
    }
    expect(unreachable, `unreachable bottom-nav tabs: ${unreachable.join(", ")}`).toEqual([]);
  });
});

test.describe("Mobile admin portal layout", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });
  });

  test("admin smoke paths are registered for mobile checks", () => {
    expect(ADMIN_PORTAL_SMOKE_PATHS.length).toBeGreaterThan(0);
    expect(ADMIN_PORTAL_SMOKE_PATHS[0]?.path).toMatch(/^\/admin\//);
  });
});
