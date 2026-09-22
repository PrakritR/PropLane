/**
 * PLAN-0920-2357 — browser regression for the manager Payments "Upcoming"
 * group + Show/Hide setting, the resident 7-day visibility window, the payment
 * record header actions, and the Payment settings dialog layout. Bundles the
 * REAL `ManagerPayments` / `ResidentPaymentsPanel` / `ProPortalSettingsModal` +
 * Tailwind CSS with esbuild and serves them through request interception (no
 * dev server, no accounts, no DB). Only session / app-UI / Next navigation /
 * analytics are stubbed; every `/api/**` call is answered by the in-memory
 * "server" below, which also records writes for assertions.
 *
 *   npx playwright test --config tests/browser/payments-upcoming.config.ts
 *
 * Set EVIDENCE_DIR to also write reviewer screenshots there.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSeed, MANAGER_ID, PROPERTY_ID } from "./seed";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "../../../src/lib/payment-automation-settings";

const evidenceDir = process.env.EVIDENCE_DIR;
async function shot(page: Page, name: string, opts: Parameters<Page["screenshot"]>[0] = {}) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), ...opts });
}
async function note(name: string, body: unknown) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

let javascript: string;
let css: string;
test.beforeAll(async () => {
  const stubs = path.resolve("tests/browser/payments-upcoming/stubs.tsx");
  const analytics = path.resolve("tests/browser/payments-upcoming/analytics-stub.ts");
  const aliases = Object.fromEntries(
    [
      "components/providers/app-ui-provider",
      "hooks/use-manager-user-id",
      "hooks/use-portal-session",
      "hooks/use-native-platform",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/payments-upcoming/fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: {
      ...aliases,
      "next/navigation": stubs,
      "next/link": stubs,
      "posthog-js": analytics,
      "@/lib/analytics/track-client": analytics,
      crypto: analytics,
      "node:crypto": analytics,
    },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  });
  javascript = bundle.outputFiles[0].text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
});

/** In-memory server state for one test: charges + automation settings + recorded writes. */
type Server = {
  seed: ReturnType<typeof buildSeed>;
  settings: Record<string, unknown>;
  writes: { url: string; method: string; body: unknown }[];
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function wire(page: Page, server: Server) {
  await page.route("http://payments-fixture.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript; charset=utf-8", body: javascript });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body: unknown = null;
    if (method !== "GET") {
      try { body = JSON.parse(req.postData() ?? "null"); } catch { body = req.postData(); }
      server.writes.push({ url: url.pathname, method, body });
    }
    if (url.pathname === "/api/portal-household-charges") {
      if (method === "GET") return json(route, { charges: server.seed.charges, rentProfiles: server.seed.rentProfiles, viewerRole: page.url().includes("surface=resident") ? "resident" : "manager" });
      // Manager mirror writes: keep the in-memory ledger in step so a reload shows the same thing.
      const payload = body as { action?: string; charges?: unknown[]; rentProfiles?: unknown[] } | null;
      if (payload?.action === "replace" && Array.isArray(payload.charges)) {
        server.seed.charges = payload.charges as typeof server.seed.charges;
      }
      return json(route, { ok: true });
    }
    if (url.pathname === "/api/workspaces") {
      return json(route, {
        workspaces: [
          {
            id: "ws-fixture",
            name: "Magnolia workspace",
            ownerUserId: MANAGER_ID,
            owned: true,
            isDefault: true,
            propertyIds: [PROPERTY_ID],
            propertyNames: { [PROPERTY_ID]: "The Magnolia" },
            propertyPermissions: {},
            livePropertyCount: 1,
          },
        ],
        activeWorkspaceId: "ws-fixture",
        plan: null,
      });
    }
    if (url.pathname === "/api/portal/scheduled-messages") {
      return json(route, { settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, ...server.settings }, messages: [] });
    }
    if (url.pathname === "/api/portal/automation-settings") {
      if (method === "PATCH" && body && typeof body === "object") Object.assign(server.settings, body as object);
      return json(route, { settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, ...server.settings } });
    }
    if (url.pathname.startsWith("/api/stripe/connect/status")) {
      return json(route, { connected: true, chargesEnabled: true, payoutsEnabled: true, paymentReady: true });
    }
    return json(route, { ok: true, records: [], rows: [], messages: [], items: [], settings: null, properties: [], applications: [], leases: [] });
  });
}

function fresh(): Server {
  return { seed: buildSeed(), settings: {}, writes: [] };
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}

const manager = (route = "/portal/payments/incoming/pending") => `http://payments-fixture.test/portal/payments?surface=manager&route=${encodeURIComponent(route)}`;
const resident = (route = "/resident/payments/pending") => `http://payments-fixture.test/resident/payments?surface=resident&route=${encodeURIComponent(route)}`;


const row = (page: Page, title: string) => page.locator('[data-attr="payment-list-row"]', { hasText: title });
const upcomingSection = (page: Page) => page.locator('[data-attr="payments-upcoming-section"]');
const pendingTabCount = async (page: Page) => (await page.locator('[data-attr="payments-bucket-pending"]').first().innerText()).replace(/\s+/g, " ");

test("manager Pending: due-now rows first, then an Upcoming group with next month's charges", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(manager());
  const { labels } = server.seed;

  await expect(row(page, `Utilities — ${labels.thisMonthName}`)).toBeVisible();
  await expect(upcomingSection(page)).toBeVisible();
  await expect(upcomingSection(page)).toContainText("Upcoming");
  await expect(upcomingSection(page)).toContainText("2");
  await expect(upcomingSection(page).locator('[data-attr="payment-list-row"]')).toHaveCount(2);
  await expect(upcomingSection(page)).toContainText(`Rent — ${labels.nextMonthName}`);
  await expect(upcomingSection(page)).toContainText("Drain repair (shared cost)");
  // Due-now row is above the Upcoming group.
  const rows = page.locator('[data-attr="payment-list-row"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`Utilities — ${labels.thisMonthName}`);
  expect(await pendingTabCount(page)).toMatch(/Pending\s*3/);
  // No status pills on rows (UI rule): the tab says the bucket.
  await expect(rows.locator("span.rounded-full", { hasText: /pending|upcoming/i })).toHaveCount(0);
  await shot(page, "01-manager-pending-upcoming-group-desktop", { fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(upcomingSection(page)).toBeVisible();
  await shot(page, "02-manager-pending-upcoming-group-phone", { fullPage: true });
  expect(errors.filter((e) => !/portal-list-control-stack|publishable key/.test(e))).toEqual([]);
});

test("manager Filter sheet: 'Upcoming charges' Hide drops the group + Pending count and PATCHes showUpcomingCharges=false", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(manager());
  const { labels } = server.seed;
  await expect(upcomingSection(page)).toBeVisible();

  await page.locator('[data-attr="payments-filter-sheet-open"]').first().click();
  const field = page.locator('[data-attr="payments-filter-upcoming-charges-trigger"]');
  await expect(field).toBeVisible();
  await expect(field).toContainText("Upcoming charges");
  await expect(field).toContainText("Show");
  await shot(page, "03-manager-filter-sheet-upcoming-field");
  await field.click();
  const list = page.locator('[data-attr="payments-filter-upcoming-charges"]');
  await expect(list).toBeVisible();
  await list.getByRole("option", { name: "Hide" }).click();
  await expect(field).toContainText("Hide");
  await shot(page, "04-manager-filter-sheet-hide-selected");
  if (await list.isVisible()) await field.click();
  await expect(list).toBeHidden();
  await page.locator('[data-attr="portal-filter-save"]').click();

  await expect(upcomingSection(page)).toHaveCount(0);
  await expect(page.locator('[data-attr="payment-list-row"]')).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(`Rent — ${labels.nextMonthName}`);
  await expect.poll(() => pendingTabCount(page)).toMatch(/Pending\s*1/);
  const patches = server.writes.filter((w) => w.url === "/api/portal/automation-settings" && w.method === "PATCH");
  expect(patches.map((w) => w.body)).toEqual([{ showUpcomingCharges: false }]);
  // The synchronous mirror for sidebar/dashboard counts follows the setting.
  expect(await page.evaluate(() => sessionStorage.getItem("axis:manager-automation-settings:showUpcomingCharges:v1"))).toBe("0");
  await shot(page, "05-manager-pending-after-hide", { fullPage: true });
  await note("filter-hide-writes.json", server.writes.filter((w) => w.url === "/api/portal/automation-settings"));

  // Reload: the persisted setting (from the "server") keeps Upcoming hidden.
  await page.reload();
  await expect(page.locator('[data-attr="payment-list-row"]')).toHaveCount(1);
  await expect(upcomingSection(page)).toHaveCount(0);
});

test("Payment settings dialog: scope bar on its own row under the title, one 'Upcoming charges in Payments' row, autopay rows once", async ({ page }) => {
  const server = fresh();
  server.settings.showUpcomingCharges = false; // saved earlier from the Filter sheet
  await wire(page, server);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(manager());
  await expect(upcomingSection(page)).toHaveCount(0);

  await page.locator('[data-attr^="settings-open-"]').first().click();
  const dialog = page.locator(".modal-panel").first();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Payment settings");
  // The scope bar renders as a row BELOW the title row, never inside it.
  const titleRow = dialog.locator("#modal-title").locator("..");
  const scopeReset = dialog.locator('[data-attr="settings-scope-reset"]');
  const titleBox = await dialog.locator("#modal-title").boundingBox();
  const scopeBarBox = await titleRow.locator("xpath=following-sibling::div[1]").boundingBox();
  expect(titleBox && scopeBarBox && scopeBarBox.y >= titleBox.y + titleBox.height - 1).toBeTruthy();
  await expect(titleRow.locator('[data-attr="settings-scope-reset"]')).toHaveCount(0);
  void scopeReset;

  // One Show/Hide row under Payment setup, reflecting the persisted value.
  const setting = dialog.locator('[data-attr="payments-settings-show-upcoming-charges"]');
  await expect(setting).toHaveCount(1);
  await expect(dialog).toContainText("Upcoming charges in Payments");
  await expect(setting).toContainText("Hide");
  // The autopay rows render exactly once even though the setup panel is mounted for setup + fee.
  await expect(dialog.getByText("Residents can set up autopay")).toHaveCount(1);
  await expect(dialog.getByText("Autopay retries a declined payment")).toHaveCount(1);
  await shot(page, "06-payment-settings-dialog-scope-bar-row");

  // Flip it back to Show from Settings → same PATCH, list regains the Upcoming group.
  await setting.click();
  await page.getByRole("option", { name: "Show" }).click();
  await expect.poll(() => server.writes.filter((w) => w.url === "/api/portal/automation-settings" && w.method === "PATCH").length).toBe(1);
  expect(server.settings.showUpcomingCharges).toBe(true);
  await shot(page, "07-payment-settings-dialog-show-selected");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(upcomingSection(page)).toBeVisible();
  await expect(page.locator('[data-attr="payment-list-row"]')).toHaveCount(3);
  await shot(page, "08-manager-pending-after-settings-show", { fullPage: true });
});

test("payment record page: no Edit pencil; Record payment marks paid; Delete removes the charge", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { labels } = server.seed;
  await page.goto(manager("/portal/payments/incoming/pending/hc_fixture_due_soon"));

  await expect(page.getByText(`Utilities — ${labels.thisMonthName}`).first()).toBeVisible();
  await expect(page.getByText("Maya Chen").first()).toBeVisible();
  const actions = page.locator('button[aria-label="Record payment"], a[aria-label="Record payment"]');
  await expect(actions.first()).toBeVisible();
  await expect(page.locator('[aria-label="Send reminder"]').first()).toBeVisible();
  await expect(page.locator('[aria-label="Delete"]').first()).toBeVisible();
  await expect(page.locator('[aria-label="Edit"]')).toHaveCount(0);
  await shot(page, "09-payment-record-header-actions");

  await actions.first().click();
  // Mark-as-paid writes the ledger mirror with the charge now paid…
  await expect.poll(() => {
    const last = server.writes.filter((w) => w.url === "/api/portal-household-charges").at(-1);
    const charges = (last?.body as { charges?: { id: string; status: string }[] } | null)?.charges ?? [];
    return charges.find((c) => c.id === "hc_fixture_due_soon")?.status;
  }).toBe("paid");
  // …and returns to the list, where the line has left Pending for Paid.
  await page.waitForURL(/route=%2Fportal%2Fpayments%2Fincoming%2Fpending$/);
  await expect(page.locator('[data-attr="payment-list-row"]')).toHaveCount(2);
  await expect(page.locator("body")).not.toContainText(`Utilities — ${labels.thisMonthName}`);
  await expect(page.locator('[data-attr="payments-bucket-paid"]').first()).toContainText("2");
  await shot(page, "10-list-after-record-payment", { fullPage: true });
  await page.goto(manager("/portal/payments/incoming/paid"));
  await expect(row(page, `Utilities — ${labels.thisMonthName}`)).toBeVisible();
  await shot(page, "11-paid-tab-after-record-payment", { fullPage: true });

  // Delete (the confirm stub answers yes) removes the charge from the mirror and the list.
  await page.goto(manager("/portal/payments/incoming/pending/hc_fixture_next_fee"));
  await expect(page.getByText("Drain repair (shared cost)").first()).toBeVisible();
  await page.locator('[aria-label="Delete"]').first().click();
  await expect.poll(() => {
    const last = server.writes.filter((w) => w.url === "/api/portal-household-charges").at(-1);
    const charges = (last?.body as { charges?: { id: string }[] } | null)?.charges ?? [];
    return charges.some((c) => c.id === "hc_fixture_next_fee");
  }).toBe(false);
  await page.waitForURL(/route=%2Fportal%2Fpayments%2Fincoming%2Fpending$/);
  await expect(page.locator('[data-attr="payment-list-row"]')).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("Drain repair (shared cost)");
  await expect(upcomingSection(page)).toContainText("1");
  await shot(page, "12-list-after-delete", { fullPage: true });
  await note(
    "record-page-writes.json",
    server.writes
      .filter((w) => w.url === "/api/portal-household-charges")
      .map((w) => ({ method: w.method, action: (w.body as { action?: string })?.action, charges: (w.body as { charges?: { id: string; status: string }[] })?.charges?.map((c) => `${c.id}:${c.status}`) })),
  );
});

test("resident Pending: next month's rent is hidden (> 7 days out); a charge the manager surfaced (residentVisibleAt) and one due in 3 days show", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(resident());
  const { labels } = server.seed;
  expect(labels.daysUntilNextRent).toBeGreaterThan(7);

  await expect(page.locator("body")).toContainText(`Utilities — ${labels.thisMonthName}`);
  await expect(page.locator("body")).toContainText("Drain repair (shared cost)");
  await expect(page.locator("body")).not.toContainText(`Rent — ${labels.nextMonthName}`);
  await expect(page.locator("body")).not.toContainText("$1,850.00");
  await shot(page, "13-resident-pending-hides-next-month-rent", { fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "14-resident-pending-phone", { fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto(resident("/resident/payments/overdue"));
  await expect(page.locator("body")).toContainText("Late fee");
  await shot(page, "15-resident-overdue", { fullPage: true });
  expect(errors.filter((e) => !/portal-list-control-stack|publishable key/.test(e))).toEqual([]);
});

