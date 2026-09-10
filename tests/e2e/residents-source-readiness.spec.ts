import { expect, test } from "@playwright/test";
import path from "node:path";

test.use({ storageState: path.join(__dirname, "../.auth/manager.json") });

test("Residents load while an unrelated inbox request remains pending", async ({ page }) => {
  test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires seeded dev/test manager");
  let releaseInbox!: () => void;
  let inboxHeld = false;
  const pendingInbox = new Promise<void>((resolve) => { releaseInbox = resolve; });
  await page.route("**/api/portal-inbox-threads?**", async (route) => {
    inboxHeld = true;
    await pendingInbox;
    await route.abort().catch(() => undefined);
  });
  try {
    await page.goto("/portal/residents/current", { waitUntil: "domcontentloaded" });
    await expect.poll(() => inboxHeld).toBe(true);
    await expect(page.getByText("Loading residents…", { exact: true })).toHaveCount(0);
    // A rendered seeded directory is stronger evidence than merely hiding the spinner.
    await expect(page.locator('main a[href*="/residents/"]').first()).toBeVisible();
  } finally {
    releaseInbox();
  }
});
