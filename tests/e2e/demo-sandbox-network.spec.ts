import { test, expect, type Page } from "@playwright/test";

/**
 * `/demo` and the home page's embeds of it must never hit a real, auth-gated
 * data API — they render from ONE bundled, deterministic "Seattle Homes"
 * dataset (`buildDemoIdleSnapshot()` in `src/lib/demo/demo-guided-data.ts`;
 * see `docs/agents/demo-sandbox.md`). This is a regression guard for that
 * contract, not a general network-purity test: analytics/telemetry and the
 * two demo-safe routes below are allowed, everything else under `/api/` is
 * not.
 */
const ALLOWED_API_PATTERNS = [
  /^\/api\/demo\//, // the public, read-only, bundled-data-only demo routes
  /^\/api\/agent\/demo-chat/, // the sandboxed assistant endpoint, demo-scoped
];

function isBannedApiRequest(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith("/api/")) return false;
  return !ALLOWED_API_PATTERNS.some((re) => re.test(pathname));
}

async function collectBannedApiRequests(page: Page, act: () => Promise<void>): Promise<string[]> {
  const banned: string[] = [];
  const onRequest = (req: { url: () => string }) => {
    const url = req.url();
    if (isBannedApiRequest(url)) banned.push(url);
  };
  page.on("request", onRequest);
  try {
    await act();
    // Let any post-load effects (e.g. a hook's useEffect) fire before we stop listening.
    await page.waitForTimeout(1500);
  } finally {
    page.off("request", onRequest);
  }
  return banned;
}

test.describe("/demo sandbox never calls a real data API", () => {
  for (const role of ["manager", "resident", "vendor"] as const) {
    test(`role=${role} dashboard fires no banned /api/ request`, async ({ page }) => {
      const banned = await collectBannedApiRequests(page, async () => {
        await page.goto(`/demo?role=${role}&section=dashboard`);
        await page.waitForLoadState("networkidle").catch(() => undefined);
      });
      expect(banned, `banned requests: ${banned.join(", ")}`).toEqual([]);
    });
  }

  test("home page's /demo embeds fire no banned /api/ request", async ({ page }) => {
    const banned = await collectBannedApiRequests(page, async () => {
      await page.goto("/");
      await page.locator("#lifecycle").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
    });
    expect(banned, `banned requests: ${banned.join(", ")}`).toEqual([]);
  });

  test("manager dashboard shows populated Seattle Homes numbers, not an empty state", async ({ page }) => {
    await page.goto("/demo?role=manager&section=dashboard");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // The seeded portfolio's applications/leases/payments all read non-zero —
    // regression guard for the class of bug this part fixed (a real number
    // reading as "0"/"nothing yet" despite the bundle holding real rows).
    await expect(main.getByText(/applications ready/i).first()).toBeVisible();
    // Occupancy and "Your properties" read from a SEPARATE store
    // (AdminPropertyRow/`adminPublishLive`) than the rest of the bundle —
    // its own regression guard, since it silently showed 0%/"No properties
    // yet" even while every other panel on this same page was populated.
    await expect(main.getByText(/^0%$/)).toHaveCount(0);
    await expect(main.getByText("No properties yet.")).toHaveCount(0);
    await expect(main.getByText("Alder House").first()).toBeVisible();
    await expect(main.getByText("Maple Duplex").first()).toBeVisible();
    await expect(main.getByText("Fremont Studio").first()).toBeVisible();
    await expect(main.getByText("Phone number not set up")).toHaveCount(0);
  });

  test("vendor Services shows the seeded scheduled job, not every bucket at 0", async ({ page }) => {
    await page.goto("/demo?role=vendor&section=work-orders");
    const main = page.locator("main");
    await expect(main.getByRole("link", { name: /current.*1 item/i })).toBeVisible();
  });

  test("resident lease record shows the seeded lease awaiting signature", async ({ page }) => {
    await page.goto("/demo?role=resident&section=lease&tab=demo-lease-demo-prop-alder");
    const main = page.locator("main");
    await expect(main.getByRole("button", { name: /^sign$/i })).toBeVisible();
    await expect(main.getByText(/resident signature pending/i).first()).toBeVisible();
  });
});
