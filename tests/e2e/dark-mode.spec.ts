import { test, expect, type Page } from "@playwright/test";
import { signInAsAdmin, signInAsManager, signInAsResident } from "../helpers/auth";
import { DARK_MODE_ENABLED } from "../../src/lib/theme-storage";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

/** Force dark theme before any page script runs. */
async function enableDarkMode(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("axis:theme", "dark");
  });
}

/** Returns count of large content panels whose computed background is near-white (RGB all > 235). */
async function countBrightBackgrounds(page: Page, rootSelector = "main") {
  return page.locator(rootSelector).evaluate((root) => {
    const isBright = (bg: string) => {
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) return false;
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      const a = m[4] !== undefined ? Number(m[4]) : 1;
      // Ignore translucent glass surfaces — only flag opaque near-white panels.
      if (a < 0.85) return false;
      return r > 235 && g > 235 && b > 235;
    };

    const nodes = root.querySelectorAll("div, section, article, aside");
    let count = 0;
    nodes.forEach((el) => {
      const htmlEl = el as HTMLElement;
      const style = getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") return;
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 60) return;
      if (htmlEl.closest("button, nav, footer, header")) return;
      if (isBright(style.backgroundColor)) count += 1;
    });
    return count;
  });
}

async function assertConfiguredTheme(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", DARK_MODE_ENABLED ? "dark" : "light");
}

async function assertConfiguredThemeAndContent(page: Page, maxBright = 2) {
  await assertConfiguredTheme(page);
  if (DARK_MODE_ENABLED) {
    const bright = await countBrightBackgrounds(page);
    expect(bright).toBeLessThanOrEqual(maxBright);
  }
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
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("partner page stays light", async ({ page }) => {
    await page.goto("/partner");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("Dark mode — auth surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await enableDarkMode(page);
  });

  test("auth sign-in card applies the configured theme", async ({ page }) => {
    await page.goto("/auth/sign-in");
    // The unified auth hub (NativeAuthHub) renders no heading and placeholder-only
    // inputs, inside a blend AuthCard (`.auth-card`, no `.glass-card`).
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await assertConfiguredTheme(page);
    const cardBg = await page
      .locator(".auth-card")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // The card must not be an opaque white panel in dark mode (transparent is fine).
    if (DARK_MODE_ENABLED) expect(cardBg).not.toMatch(/rgb\(255,\s*255,\s*255/);
  });

  test("auth create-account applies the configured theme", async ({ page }) => {
    await page.goto("/auth/create-account");
    // PRP-307: the bare create surface is the role chooser, not a form — the
    // fields live behind Property / Resident / Vendor.
    await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^property/i })).toBeVisible();
    await assertConfiguredTheme(page);
    await assertConfiguredThemeAndContent(page, 0);
  });
});

test.describe("Dark mode — property portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await enableDarkMode(page);
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
    test(`${route} applies configured theme to main content`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertConfiguredThemeAndContent(page, 0);
    });
  }
});

test.describe("Appearance setting", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  test("preferences exposes Appearance only when enabled", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/profile?tab=preferences");
    await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
    const appearance = page.getByRole("heading", { name: "Appearance", exact: true });
    if (DARK_MODE_ENABLED) await expect(appearance).toBeVisible();
    else await expect(appearance).toHaveCount(0);
  });
});

test.describe("Dark mode — resident portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await enableDarkMode(page);
    await signInAsResident(page);
  });

  const routes = ["/resident/dashboard", "/resident/lease", "/resident/payments"] as const;

  for (const route of routes) {
    test(`${route} applies configured theme to main content`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertConfiguredThemeAndContent(page, 0);
    });
  }
});

test.describe("Dark mode — admin portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await enableDarkMode(page);
    await signInAsAdmin(page);
  });

  const routes = ["/admin/dashboard", "/admin/service", "/admin/axis-users", "/admin/events", "/admin/communication/inbox/unopened"] as const;

  for (const route of routes) {
    test(`${route} applies configured theme to main content`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertConfiguredThemeAndContent(page, 0);
    });
  }
});
