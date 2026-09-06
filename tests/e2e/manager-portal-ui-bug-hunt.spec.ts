import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { mockStripeAllRoutes } from "../helpers/auth";
import { pathToUrlRegExp } from "../helpers/url-match";
import { MANAGER_PORTAL_SMOKE_PATHS } from "@/lib/portals/pro";

/**
 * Manager portal UI bug hunt — automated half of proplane-manager-portal-bug-hunt skill.
 *
 * Run (dev server already on 3010):
 *   PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 \
 *     E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/manager-portal-ui-bug-hunt.spec.ts
 */

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 800 };

const PROPERTIES_PATHS = [
  "/portal/properties",
  "/portal/properties/listed",
  "/portal/properties/pending",
  "/portal/properties/drafts",
] as const;

test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });

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

async function assertMainContentScrollable(page: Page) {
  const metrics = await page.evaluate(() => {
    const main = document.getElementById("portal-main-content");
    if (!main) return null;
    const style = getComputedStyle(main);
    return {
      overflowY: style.overflowY,
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
      canScroll: main.scrollHeight > main.clientHeight + 4,
    };
  });
  expect(metrics, "#portal-main-content should exist").not.toBeNull();
  if (metrics && metrics.canScroll) {
    expect(
      ["auto", "scroll", "overlay"].includes(metrics.overflowY),
      `main should allow vertical scroll when content overflows (overflow-y=${metrics.overflowY})`,
    ).toBe(true);
  }
}

test.describe("Manager portal UI bug hunt", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await mockStripeAllRoutes(page);
  });

  test("desktop: smoke paths load without horizontal overflow", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(DESKTOP);

    for (const { path: route, label } of MANAGER_PORTAL_SMOKE_PATHS) {
      await gotoTolerantly(page, route);
      await expect(page).toHaveURL(pathToUrlRegExp(route), { timeout: 30_000 });
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 25_000 });
      await assertNoHorizontalOverflow(page, `${label} @ desktop`);
    }
  });

  test("mobile native: smoke paths load without horizontal overflow", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(MOBILE);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });

    for (const { path: route, label } of MANAGER_PORTAL_SMOKE_PATHS) {
      await gotoTolerantly(page, route);
      await expect(page).toHaveURL(pathToUrlRegExp(route), { timeout: 30_000 });
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 25_000 });
      await assertNoHorizontalOverflow(page, `${label} @ mobile`);
    }
  });

  test("properties stages: no horizontal overflow at narrow width", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(NARROW);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });

    for (const route of PROPERTIES_PATHS) {
      await gotoTolerantly(page, route);
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 25_000 });
      await assertNoHorizontalOverflow(page, route);
    }
  });

  test("properties listed: main content scroll chain when list is long", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoTolerantly(page, "/portal/properties/listed");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 25_000 });
    await assertMainContentScrollable(page);
  });

  test("mobile: portal main reserves bottom inset on native", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-native", "ios");
    });
    await gotoTolerantly(page, "/portal/properties/listed");
    await expect(page.locator("#portal-main-content")).toBeVisible();

    const inset = await page.evaluate(() => {
      const main = document.getElementById("portal-main-content");
      if (!main) return null;
      return getComputedStyle(main).paddingBottom;
    });
    expect(inset, "native shell should reserve bottom inset on main content").toBeTruthy();
    expect(inset).not.toBe("0px");
  });

  test("properties: add affordance visible without horizontal clip", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await gotoTolerantly(page, "/portal/properties/listed");
    const createBtn = page
      .locator('[data-attr="manager-properties-create"]')
      .or(page.getByRole("button", { name: /^Add$/i }))
      .first();
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
    const box = await createBtn.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      const viewport = page.viewportSize();
      expect(box.x + box.width).toBeLessThanOrEqual((viewport?.width ?? MOBILE.width) + 2);
      expect(box.x).toBeGreaterThanOrEqual(-2);
    }
  });

  test("filter panel on properties listed opens listbox below trigger", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoTolerantly(page, "/portal/properties/listed");
    const filterBtn = page.getByRole("button", { name: /^Filter/i }).first();
    if (await filterBtn.count() === 0) {
      test.skip(true, "No filter button on this properties view");
      return;
    }
    await filterBtn.click();
    const panel = page.locator('[data-slot="portal-filter-dropdown-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const fieldTrigger = panel.getByRole("button").first();
    await fieldTrigger.click();
    const listbox = page.getByRole("listbox").first();
    await expect(listbox).toBeVisible({ timeout: 8_000 });
    const triggerBox = await fieldTrigger.boundingBox();
    const listboxBox = await listbox.boundingBox();
    expect(triggerBox && listboxBox).toBeTruthy();
    if (triggerBox && listboxBox) {
      expect(listboxBox.y).toBeGreaterThanOrEqual(triggerBox.y - 4);
    }
    await expect(listbox).toHaveCSS("overflow-y", "auto");
  });
});
