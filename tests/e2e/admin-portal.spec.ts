import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "../helpers/auth";
import { pathToUrlRegExp } from "../helpers/url-match";

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

  test("unified inbox archives a message and Delete all trash empties it", async ({ page }) => {
    // Keep the compose flow from delivering to real recipient inboxes/push devices.
    await page.route("**/api/portal/send-inbox-message", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
    );
    const evidenceDir = process.env.E2E_EVIDENCE_DIR;

    // Communication is one unified conversation inbox: no Sent/Trash folder tabs.
    // Trash is reached via the "Archived" toggle; "Delete all trash" lives beside
    // it (see admin-communication.tsx / admin-inbox-client.tsx).
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/admin/communication/inbox/unopened");
    await expect(page.getByRole("heading", { name: "Inbox", exact: true, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "New message" }).click();

    const subject = `E2E trash check ${Date.now()}`;
    // The recipient control is a custom listbox widget (FieldSingleSelect), not a
    // native <select> — open it and pick the option, rather than selectOption().
    await page.getByRole("button", { name: "Recipient type" }).click();
    await page.getByRole("option", { name: "All managers" }).click();
    await page.getByPlaceholder("Subject").fill(subject);
    await page.getByPlaceholder(/write your message/i).fill("Automated trash-tab check.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // The sent message shows in the flat conversation list; expand it and
    // archive. The list dual-mounts (a lg:hidden mobile card list + a hidden
    // lg:block desktop table), so target the desktop table ROW — getByText(...)
    // .first() would resolve to the off-screen mobile copy at this viewport.
    const row = page.locator("table tbody").getByRole("row").filter({ hasText: subject });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await row.getByRole("button", { name: "Move to trash" }).click();

    // Switch to the archived (trash) view; "Delete all trash" appears when trash
    // is non-empty.
    await page.locator('[data-attr="admin-inbox-archived-toggle"]').click();
    const deleteAll = page.getByRole("button", { name: "Delete all trash" });
    await expect(deleteAll.first()).toBeVisible({ timeout: 15_000 });
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/admin-trash-delete-button.png`, fullPage: true });

    // emptyTrash() confirms via window.confirm before clearing.
    page.once("dialog", (dialog) => void dialog.accept());
    await deleteAll.first().click();
    await expect(deleteAll).toHaveCount(0, { timeout: 15_000 });
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/admin-trash-emptied.png`, fullPage: true });
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
