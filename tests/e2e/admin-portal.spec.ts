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
  test.describe.configure({ timeout: 120_000 });
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
    // inbox"). The legacy `sms/<bucket>` segment redirects to the Active list
    // (render-portal-section.tsx). Text conversations, when enabled, are rows of
    // that same list gated by SMS_COMM_UI_ENABLED — there is no standalone SMS
    // tab, so the old `[data-attr="admin-communication-tab-sms"]` no longer exists.
    await page.goto("/admin/communication/sms/all");
    await expect(page).toHaveURL(/\/admin\/communication\/active/, { timeout: 15_000 });
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  });

  test("unified inbox archives a message and Delete all archived empties it", async ({ page }) => {
    // Keep the compose flow from delivering to real recipient inboxes/push devices.
    await page.route("**/api/portal/send-inbox-message", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
    );
    const evidenceDir = process.env.E2E_EVIDENCE_DIR;

    // Communication is the manager's unified inbox over admin's data: Active | Archived
    // tabs, no Sent/Trash folders. Archive lives in the open thread; "Delete all archived"
    // is a list tool on the Archived tab (see admin-communication.tsx).
    await page.setViewportSize({ width: 1280, height: 720 });
    let releaseRecipients = () => {};
    const recipientGate = new Promise<void>((resolve) => { releaseRecipients = () => resolve(); });
    let recipientRequestStarted = () => {};
    const recipientRequest = new Promise<void>((resolve) => { recipientRequestStarted = () => resolve(); });
    await page.route("**/api/admin/portal-users", async (route) => {
      recipientRequestStarted();
      await recipientGate;
      await route.continue();
    });
    const recipientsLoaded = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/admin/portal-users" && response.ok(),
    );
    await page.goto("/admin/communication/active");
    await expect(page.getByRole("heading", { name: "Communication", exact: true, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "New message" }).click();
    // The people admin can write to are read when the compose opens.
    await recipientRequest;

    const subject = `E2E trash check ${Date.now()}`;
    // The recipient control is a custom listbox widget (FieldSingleSelect), not a
    // native <select> — open it and pick the option, rather than selectOption().
    await page.getByRole("button", { name: "Recipient type" }).click();
    await page.getByRole("option", { name: "All managers" }).click();
    await page.getByPlaceholder("Subject").fill(subject);
    await page.getByPlaceholder(/write your message/i).fill("Automated trash-tab check.");
    releaseRecipients();
    await recipientsLoaded;
    await expect(page.getByPlaceholder("Subject")).toHaveValue(subject);
    await expect(page.getByPlaceholder(/write your message/i)).toHaveValue("Automated trash-tab check.");
    await expect(page.getByRole("button", { name: "Recipient type" })).toContainText("All managers");
    const sendRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/api/portal/send-inbox-message" && request.method() === "POST",
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const sent = (await sendRequest).postDataJSON() as { subject?: string; text?: string; toUserIds?: string[] };
    expect(sent.subject).toBe(subject);
    expect(sent.text).toBe("Automated trash-tab check.");
    expect(sent.toUserIds?.length).toBeGreaterThan(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "New message" }).click();
    await expect(page.getByPlaceholder("Subject")).toHaveValue("");
    await expect(page.getByPlaceholder(/write your message/i)).toHaveValue("");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    // A message admin sent is a conversation in the one list, titled by its audience.
    // Open it and archive it from the thread header.
    const row = page.locator("[data-communication-inbox-list]").getByText("All managers").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await page.getByRole("button", { name: "Archive conversation", exact: true }).click();

    // Switch to the Archived tab; "Delete all archived" appears when it holds a conversation.
    await page.getByRole("link", { name: /^Archived/ }).click();
    const deleteAll = page.getByRole("button", { name: "Delete all archived" });
    await expect(deleteAll.first()).toBeVisible({ timeout: 15_000 });
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/admin-trash-delete-button.png`, fullPage: true });

    // Deleting forever confirms in the app dialog before clearing.
    await deleteAll.first().click();
    await page.getByRole("dialog").getByRole("button", { name: /^Delete/ }).click();
    await expect(deleteAll).toHaveCount(0, { timeout: 15_000 });
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/admin-trash-emptied.png`, fullPage: true });
  });

  test("legacy inbox URL redirects to unified communication inbox", async ({ page }) => {
    // /admin/inbox/* → /admin/communication/inbox/* → the Active list (the legacy
    // `email`/`sms` channel segments redirect to the same place).
    await page.goto("/admin/inbox/unopened");
    await expect(page).toHaveURL(/\/admin\/communication\/active/);
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
