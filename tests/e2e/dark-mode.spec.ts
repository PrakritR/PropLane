import { test, expect, type Page } from "@playwright/test";
import { signInAsAdmin, signInAsManager, signInAsResident } from "../helpers/auth";

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

async function assertDarkThemeActive(page: Page) {
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(theme).toBe("dark");
}

async function assertMainContentNotLightThemed(page: Page, maxBright = 2) {
  await assertDarkThemeActive(page);
  const bright = await countBrightBackgrounds(page);
  expect(bright).toBeLessThanOrEqual(maxBright);
}

test.describe("Public marketing — light theme only", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("axis:theme", "dark");
    });
  });

  test("marketing home stays light even when dark is saved", async ({ page }) => {
    await page.goto("/");
    // Anchor on the current hero (landing-demo-hero.tsx). The three block spans
    // concatenate without whitespace in the accessible name, so match the start.
    await expect(page.getByRole("heading", { name: /the ai does/i })).toBeVisible();
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(theme).toBe("light");
  });

  test("partner page stays light", async ({ page }) => {
    await page.goto("/partner");
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(theme).toBe("light");
  });
});

test.describe("Dark mode — auth surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await enableDarkMode(page);
  });

  test("auth sign-in card respects dark theme", async ({ page }) => {
    await page.goto("/auth/sign-in");
    // The unified auth hub (NativeAuthHub) renders no heading and placeholder-only
    // inputs, inside a blend AuthCard (`.auth-card`, no `.glass-card`).
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await assertDarkThemeActive(page);
    const cardBg = await page
      .locator(".auth-card")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // The card must not be an opaque white panel in dark mode (transparent is fine).
    expect(cardBg).not.toMatch(/rgb\(255,\s*255,\s*255/);
  });

  test("auth create-account is readable in dark mode", async ({ page }) => {
    await page.goto("/auth/create-account");
    // Generic create surface: Google OAuth, placeholder inputs, and "Create account".
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
    await assertDarkThemeActive(page);
    await assertMainContentNotLightThemed(page, 0);
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
    test(`${route} has no light-themed main content`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertMainContentNotLightThemed(page, 0);
    });
  }
});

test.describe("Dark mode — resident portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await enableDarkMode(page);
    await signInAsResident(page);
  });

  const routes = ["/resident/dashboard", "/resident/lease", "/resident/payments"] as const;

  for (const route of routes) {
    test(`${route} has no light-themed main content`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertMainContentNotLightThemed(page, 0);
    });
  }
});

test.describe("Dark mode — admin portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeEach(async ({ page }) => {
    await enableDarkMode(page);
    await signInAsAdmin(page);
  });

  const routes = ["/admin/dashboard", "/admin/properties", "/admin/axis-users", "/admin/events", "/admin/communication/inbox/unopened"] as const;

  for (const route of routes) {
    test(`${route} has no light-themed main content`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await assertMainContentNotLightThemed(page, 0);
    });
  }
});
