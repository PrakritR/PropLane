import { test, expect, type Page } from "@playwright/test";

/**
 * Captain 2026-09-26: "remove live demo no need" — the public site no
 * longer embeds or links the running `/demo` sandbox anywhere. `/demo` and
 * every `/demo/*` sub-path now redirect to `/` (`next.config.ts`,
 * `src/middleware.ts`); the home page's product panels
 * (`site/lifecycle-rows.tsx`, `site/switch-steps.tsx`,
 * `site/codex-hero-window.tsx`) render the real portal presentational
 * components fed static fixtures instead of a live `<iframe src="/demo">`.
 * This replaces the old iframe/postMessage network-purity spec — see
 * `docs/agents/demo-sandbox.md`.
 */
const ALLOWED_API_PATTERNS = [/^\/api\/agent\/demo-chat/];

function isBannedApiRequest(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/demo")) return false;
  if (pathname.startsWith("/demo")) return true; // never requested at all any more
  return !ALLOWED_API_PATTERNS.some((re) => re.test(pathname));
}

async function collectBannedRequests(page: Page, act: () => Promise<void>): Promise<string[]> {
  const banned: string[] = [];
  const onRequest = (req: { url: () => string }) => {
    const url = req.url();
    if (isBannedApiRequest(url)) banned.push(url);
  };
  page.on("request", onRequest);
  try {
    await act();
    await page.waitForTimeout(1500);
  } finally {
    page.off("request", onRequest);
  }
  return banned;
}

test.describe("/demo is retired from the public site", () => {
  test("/demo redirects home", async ({ page }) => {
    await page.goto("/demo");
    await expect(page).toHaveURL(/\/$/);
  });

  test("/demo/anything redirects home", async ({ page }) => {
    await page.goto("/demo/role/manager");
    await expect(page).toHaveURL(/\/$/);
  });

  test("home page fires no /demo and no banned /api/ request", async ({ page }) => {
    const banned = await collectBannedRequests(page, async () => {
      await page.goto("/");
      await page.locator("#lifecycle").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
    });
    expect(banned, `banned requests: ${banned.join(", ")}`).toEqual([]);
  });

  test("hero renders the populated static dashboard panel", async ({ page }) => {
    await page.goto("/");
    const hero = page.locator(".codex-hero-window");
    await expect(hero.getByText("Occupancy").first()).toBeVisible();
    await expect(hero.getByText("67%").first()).toBeVisible();
    await expect(hero.getByText("Alder House").first()).toBeVisible();
  });

  test("each lifecycle row renders a filled, non-empty product panel", async ({ page }) => {
    await page.goto("/");
    for (const [id, expectedText] of [
      ["tours", "Fremont Studio"],
      ["applications", "Sample Applicant"],
      ["leasing", "Dana Reyes"],
      ["payments", "September rent"],
      ["services", "Kitchen faucet drip"],
    ] as const) {
      const row = page.locator(`[data-lifecycle-row="${id}"]`);
      await row.scrollIntoViewIfNeeded();
      await expect(row.getByText(expectedText).first()).toBeVisible();
    }
  });

  test("the switching section renders the real import review panel", async ({ page }) => {
    await page.goto("/");
    await page.locator("#site-switch-heading").scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { level: 1, name: "Review what the agent found" })).toBeVisible();
    await expect(page.getByText("Dana Reyes").first()).toBeVisible();
  });
});
