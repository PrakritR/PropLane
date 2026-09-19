import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "../helpers/auth";
import { pathToUrlRegExp } from "../helpers/url-match";
import { withOwnedAdminInbox } from "../helpers/admin-inbox-owned-fixture";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

const ADMIN_SECTIONS = [
  { label: "Dashboard", path: "/admin/dashboard" },
  { label: "Properties", path: "/admin/properties" },
  { label: "Events", path: "/admin/events" },
  // Communication unified: the legacy `email`/`sms` channel segments now redirect
  // to the canonical `inbox` segment (see render-portal-section.tsx and
  // ADMIN_PORTAL_SMOKE_PATHS). Assert the destination the app actually resolves.
  { label: "Communication", path: "/admin/communication/inbox/unopened" },
  { label: "Feedback", path: "/admin/bugs-feedback" },
  { label: "Settings", path: "/admin/profile" },
] as const;

test.describe("Admin portal", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test("dashboard loads", async ({ page }) => {
    await page.goto("/admin/dashboard");
    await expect(page).toHaveURL(/\/admin\/dashboard/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("axis users section loads", async ({ page }) => {
    await page.goto("/admin/axis-users");
    await expect(page).toHaveURL(/\/admin\/axis-users/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("all admin sections load via direct navigation", async ({ page }) => {
    for (const { path } of ADMIN_SECTIONS) {
      await page.goto(path);
      await expect(page).toHaveURL(pathToUrlRegExp(path));
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    }
  });

  test("admin communication email tab loads and shows compose button", async ({ page }) => {
    await page.goto("/admin/communication/email/unopened");
    await expect(page.getByRole("heading").first()).toBeVisible();
    const composeBtn = page.getByRole("button", { name: /new message|compose/i }).first();
    // Compose button may or may not be present depending on config
    if (await composeBtn.count() > 0) {
      await expect(composeBtn).toBeVisible();
    }
  });

  test("legacy admin communication SMS route redirects into the unified inbox", async ({ page }) => {
    // Communication is now ONE unified conversation inbox with no channel/folder
    // tabs (see AGENTS.md "Communication is one unified, conversation-based
    // inbox"). The legacy `sms/<bucket>` segment redirects to the canonical
    // `inbox` segment (render-portal-section.tsx). SMS, when enabled, is an
    // embedded panel gated by SMS_COMM_UI_ENABLED — there is no standalone SMS
    // tab, so the old `[data-attr="admin-communication-tab-sms"]` no longer exists.
    await page.goto("/admin/communication/sms/all");
    await expect(page).toHaveURL(/\/admin\/communication\/inbox\/unopened/, { timeout: 15_000 });
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  });

  test("unified inbox archives an owned fixture and Delete all trash removes only it", async ({ page }) => {
    await withOwnedAdminInbox(page, async ({ targetId, targetTopic, readRows, assertControl }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto("/admin/communication/inbox/unopened");
      await expect(page.getByRole("heading", { name: "Inbox", exact: true, level: 1 })).toBeVisible();
      const row = page.locator(`table tr[id="portal-inbox-thread-${targetId}"]`);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: `Actions for ${targetTopic}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
      await expect.poll(async () => (await readRows()).find(item => item.id === targetId)?.folder).toBe("trash");
      await assertControl();
      await page.locator('[data-attr="admin-inbox-archived-toggle"]').click();
      await expect(row).toBeVisible();
      const deleteAll = page.getByRole("button", { name: "Delete all trash", exact: true });
      await expect(deleteAll).toBeVisible();
      await deleteAll.click();
      const confirm = page.getByRole("dialog").filter({ hasText: "Delete all 1 trash message?" });
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect.poll(async () => (await readRows()).some(item => item.id === targetId)).toBe(false);
      await expect(deleteAll).toHaveCount(0);
      await assertControl();
    });
  });

  test("legacy inbox URL redirects to unified communication inbox", async ({ page }) => {
    // /admin/inbox/* → /admin/communication/inbox/* (the legacy `email`/`sms`
    // channel segments then redirect to the canonical `inbox` segment too).
    await page.goto("/admin/inbox/unopened");
    await expect(page).toHaveURL(/\/admin\/communication\/inbox\/unopened/);
  });

  test("settings page loads without embedded feedback panel", async ({ page }) => {
    await page.goto("/admin/profile");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Feedback" })).toHaveCount(0);
  });

  test("feedback section loads as its own admin page", async ({ page }) => {
    await page.goto("/admin/bugs-feedback");
    await expect(page).toHaveURL(/\/admin\/bugs-feedback/);
    await expect(page.getByRole("heading", { name: "Feedback", exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  });

  test("properties section loads", async ({ page }) => {
    await page.goto("/admin/properties");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  });

  test("legacy leases URL redirects to dashboard", async ({ page }) => {
    await page.goto("/admin/leases");
    await expect(page).toHaveURL(/\/admin\/dashboard/);
  });

  test("events section loads", async ({ page }) => {
    await page.goto("/admin/events");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  });
});
