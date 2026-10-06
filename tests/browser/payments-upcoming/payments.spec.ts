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
  balance: Record<string, unknown>;
  destinations: Record<string, unknown>[];
};

/**
 * `/api/stripe/payouts/balance` the way `snapshotWithPlatformHolds` composes it:
 * money captured on the PropLane platform sits in `heldCents` until it is
 * transferred to the owner's Connect account, `withdrawableCents` is what the
 * provider actually holds, and the recovery legs carry refund/recovery debt.
 * Two hold-history rows stand in for a captured source allocation still held and
 * one already moved across.
 */
function payoutsBalance(): Record<string, unknown> {
  return {
    currency: "usd",
    availableCents: 184_000,
    withdrawableCents: 59_000,
    instantAvailableCents: 0,
    pendingCents: 0,
    onTheWayCents: 0,
    payoutReconciliationPending: false,
    heldCents: 125_000,
    releasePendingCents: 0,
    recoveryOutstandingCents: 0,
    recoveryReservedCents: 0,
    heldDepositCents: 95_000,
    availableNote: "",
    bank: { last4: "6789", bankName: "Test Bank", accountType: "checking", instantEligible: false, verifiedAt: "2026-09-30T18:00:00.000Z" },
    schedule: { interval: "weekly", nextPayoutAt: null },
    setup: { identity: "done", bank: "done", ready: true },
    history: [
      {
        id: "hold:held-1", kind: "source_movement", amountCents: 125_000, feeCents: 0, netCents: 125_000,
        method: null, status: "pending", destinationLast4: null, createdAt: "2026-10-02T17:00:00.000Z",
        arrivalDate: null, initiatedInApp: false, failureMessage: null, serviceLabel: "Captured source allocation",
      },
      {
        id: "hold:moved-1", kind: "source_movement", amountCents: 59_000, feeCents: 0, netCents: 59_000,
        method: null, status: "paid", destinationLast4: null, createdAt: "2026-09-29T17:00:00.000Z",
        arrivalDate: null, initiatedInApp: false, failureMessage: null, serviceLabel: "Moved from PropLane to Stripe",
      },
    ],
  };
}

function payoutDestinations(): Record<string, unknown>[] {
  return [{
    id: "ba_test_6789", kind: "bank", label: "Test Bank checking", last4: "6789",
    status: "verified", payable: true, instantEligible: false, default: true,
  }];
}

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
      const payload = body as { action?: string; id?: string; paidAt?: string; method?: string; charges?: unknown[]; rentProfiles?: unknown[] } | null;
      if (payload?.action === "replace" && Array.isArray(payload.charges)) {
        server.seed.charges = payload.charges as typeof server.seed.charges;
      }
      // "Mark paid offline" is server-confirmed (`recordHouseholdChargeOfflinePayment`):
      // the browser only keeps the charge the server echoes back, so the fixture
      // has to apply the payment itself and return the updated row.
      if (payload?.action === "recordOfflinePayment" && payload.id) {
        const index = server.seed.charges.findIndex((charge) => charge.id === payload.id);
        if (index === -1) return json(route, { error: "No such charge." }, 404);
        const paid = {
          ...server.seed.charges[index],
          status: "paid",
          balanceLabel: "$0.00",
          paidAt: payload.paidAt ?? new Date().toISOString(),
          paidMethod: (payload.method ?? "Other").toLowerCase(),
        } as (typeof server.seed.charges)[number];
        server.seed.charges = server.seed.charges.map((charge, i) => (i === index ? paid : charge));
        return json(route, { charge: paid });
      }
      return json(route, { ok: true });
    }
    // The Payments ledger hides a charge whose resident has no application row
    // (the orphaned-resident backstop in `manager-payments-scope.ts`), so the
    // directory row is as load-bearing as the charges themselves.
    if (url.pathname === "/api/manager-applications") {
      if (method === "GET") return json(route, { rows: server.seed.applications });
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
    // Payment settings mounts the payouts page, which reads `balance.setup.ready`
    // straight off this body — the catch-all's `{ ok: true }` crashed it (and
    // with it the whole dialog), so answer the real contract shape. Central
    // source arbitration added the platform-hold legs to that contract
    // (`isPortalPayoutBalance` now demands `withdrawableCents`, `heldCents`,
    // `releasePendingCents`, `recoveryOutstandingCents`, `recoveryReservedCents`);
    // a body missing them is rejected whole and the dialog renders
    // "Could not load payouts." instead of its sections.
    if (url.pathname === "/api/stripe/payouts/balance") {
      return json(route, server.balance);
    }
    // Payout destinations are read from the live Connect list, not off the
    // balance's display-only bank summary; the catch-all's `{ ok: true }` has no
    // `destinations`, which the page treats as unverifiable.
    if (url.pathname === "/api/stripe/connect/bank-accounts") {
      return json(route, { destinations: server.destinations });
    }
    if (url.pathname === "/api/portal/proplane-balance") {
      return json(route, { enabled: true });
    }
    if (url.pathname.startsWith("/api/portal/manager-manual-payment-settings")) {
      return json(route, { workspacePaymentSettings: {} });
    }
    if (url.pathname.startsWith("/api/stripe/connect/status")) {
      return json(route, { connected: true, chargesEnabled: true, payoutsEnabled: true, paymentReady: true });
    }
    return json(route, { ok: true, records: [], rows: [], messages: [], items: [], settings: null, properties: [], applications: [], leases: [] });
  });
}

function fresh(): Server {
  return { seed: buildSeed(), settings: {}, writes: [], balance: payoutsBalance(), destinations: payoutDestinations() };
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
/**
 * Pending holds due-now charges and later-month ones in ONE flat list — the
 * "Upcoming" heading and its `payments-upcoming-section` wrapper were dropped
 * in 6afe5543e ("charges sit in one list"), and
 * `tests/unit/manager-payments-upcoming.test.tsx` is the unit guard that they
 * never come back. What survives is the ORDER (due now first) and the
 * Show/Hide setting, which still removes the later-month rows outright.
 */
const listRows = (page: Page) => page.locator('[data-attr="payment-list-row"]');
const upcomingSection = (page: Page) => page.locator('[data-attr="payments-upcoming-section"]');
const pendingTabCount = async (page: Page) => (await page.locator('[data-attr="payments-bucket-pending"]').first().innerText()).replace(/\s+/g, " ");

test("manager Pending: due-now rows first, then next month's charges, in one flat list", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(manager());
  const { labels } = server.seed;

  await expect(row(page, `Utilities — ${labels.thisMonthName}`)).toBeVisible();
  // One list, no "Upcoming" group: the later-month rows are plain rows.
  await expect(upcomingSection(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Upcoming");
  const rows = listRows(page);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`Utilities — ${labels.thisMonthName}`);
  await expect(rows.nth(1)).toContainText(`Rent — ${labels.nextMonthName}`);
  await expect(rows.nth(2)).toContainText("Drain repair (shared cost)");
  expect(await pendingTabCount(page)).toMatch(/Pending\s*3/);
  // No status pills on rows (UI rule): the tab says the bucket.
  await expect(rows.locator("span.rounded-full", { hasText: /pending|upcoming/i })).toHaveCount(0);
  await shot(page, "01-manager-pending-flat-list-desktop", { fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(listRows(page).first()).toBeVisible();
  await shot(page, "02-manager-pending-flat-list-phone", { fullPage: true });
  expect(errors.filter((e) => !/portal-list-control-stack|publishable key/.test(e))).toEqual([]);
});

test("manager Filter sheet: 'Upcoming charges' Hide drops the later-month rows + Pending count and PATCHes showUpcomingCharges=false", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(manager());
  const { labels } = server.seed;
  await expect(listRows(page)).toHaveCount(3);

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

  await expect(listRows(page)).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(`Rent — ${labels.nextMonthName}`);
  await expect(page.locator("body")).not.toContainText("Drain repair (shared cost)");
  await expect.poll(() => pendingTabCount(page)).toMatch(/Pending\s*1/);
  const patches = server.writes.filter((w) => w.url === "/api/portal/automation-settings" && w.method === "PATCH");
  expect(patches.map((w) => w.body)).toEqual([{ showUpcomingCharges: false }]);
  // The synchronous mirror for sidebar/dashboard counts follows the setting.
  expect(await page.evaluate(() => sessionStorage.getItem("axis:manager-automation-settings:showUpcomingCharges:v1"))).toBe("0");
  await shot(page, "05-manager-pending-after-hide", { fullPage: true });
  await note("filter-hide-writes.json", server.writes.filter((w) => w.url === "/api/portal/automation-settings"));

  // Reload: the persisted setting (from the "server") keeps them hidden.
  await page.reload();
  await expect(listRows(page)).toHaveCount(1);
});

test("Payment settings dialog: scope bar on its own row under the title; the Show/Hide value lives in the Filter sheet alone", async ({ page }) => {
  const server = fresh();
  server.settings.showUpcomingCharges = false; // saved earlier from the Filter sheet
  await wire(page, server);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(manager());
  await expect(listRows(page)).toHaveCount(1);

  await page.locator('[data-attr^="settings-open-"]').first().click();
  const dialog = page.locator(".modal-panel").first();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Payment settings");
  // The scope bar renders as a row BELOW the title row, never inside it.
  const title = dialog.getByRole("heading", { name: "Payment settings" }).first();
  const titleRow = title.locator("..");
  const scopeBar = titleRow.locator("xpath=following-sibling::div[1]");
  await expect(scopeBar.locator('[data-attr="settings-scope-workspace"]')).toBeVisible();
  const titleBox = await title.boundingBox();
  const scopeBarBox = await scopeBar.boundingBox();
  expect(titleBox && scopeBarBox && scopeBarBox.y >= titleBox.y + titleBox.height - 1).toBeTruthy();
  await expect(titleRow.locator('[data-attr="settings-scope-reset"]')).toHaveCount(0);

  // ONE entry point for the setting. The dialog carried a second "Upcoming
  // charges in Payments" row until 2858fde19 removed it; two controls over one
  // `/api/portal/automation-settings` field could silently undo each other.
  await expect(dialog.locator('[data-attr="payments-settings-show-upcoming-charges"]')).toHaveCount(0);
  await expect(dialog).not.toContainText("Upcoming charges in Payments");
  // The payouts surface it does carry is mounted once, not once per sub-panel.
  for (const section of ["PropLane balance", "Paying vendors and bills", "Bank accounts"]) {
    await expect(dialog.getByRole("heading", { name: section, exact: true })).toHaveCount(1);
  }
  await shot(page, "06-payment-settings-dialog-scope-bar-row");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Flip it back to Show in the Filter sheet: same saved value, rows return.
  await page.locator('[data-attr="payments-filter-sheet-open"]').first().click();
  const field = page.locator('[data-attr="payments-filter-upcoming-charges-trigger"]');
  await expect(field).toContainText("Hide");
  await field.click();
  const options = page.locator('[data-attr="payments-filter-upcoming-charges"]');
  await options.getByRole("option", { name: "Show" }).click();
  await expect(field).toContainText("Show");
  if (await options.isVisible()) await field.click();
  await expect(options).toBeHidden();
  await page.locator('[data-attr="portal-filter-save"]').click();
  await expect.poll(() => server.writes.filter((w) => w.url === "/api/portal/automation-settings" && w.method === "PATCH").length).toBe(1);
  expect(server.settings.showUpcomingCharges).toBe(true);
  await expect(listRows(page)).toHaveCount(3);
  await shot(page, "07-manager-pending-after-settings-show", { fullPage: true });
});

test("payment record page: C2-PAY header actions; Mark paid offline is server-confirmed; Delete removes the charge", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { labels } = server.seed;
  await page.goto(manager("/portal/payments/incoming/pending/hc_fixture_due_soon"));

  await expect(page.getByText(`Utilities — ${labels.thisMonthName}`).first()).toBeVisible();
  await expect(page.getByText("Maya Chen").first()).toBeVisible();
  // C2-PAY (58d9a59d8): take payment, mark paid offline, send reminder, edit,
  // download, delete. The header renders for desktop and phone, so CSS hides
  // one copy of each — assert the visible one.
  for (const label of ["Take payment", "Mark paid offline", "Send reminder", "Edit", "Download", "Delete"]) {
    await expect(page.locator(`[aria-label="${label}"]`).filter({ visible: true }).first()).toBeVisible();
  }
  await shot(page, "09-payment-record-header-actions");

  await page.locator('[aria-label="Mark paid offline"]').filter({ visible: true }).first().click();
  const offlineDialog = page.locator(".modal-panel").filter({ hasText: "Mark paid offline" }).first();
  await expect(offlineDialog).toBeVisible();
  await offlineDialog.getByRole("button", { name: "Mark paid", exact: true }).click();
  // The charge is paid only because the SERVER said so: the browser keeps the
  // row this POST echoes back, never a locally-flipped status.
  await expect.poll(() => server.writes.filter((w) => (w.body as { action?: string })?.action === "recordOfflinePayment").length).toBe(1);
  await expect.poll(() => server.seed.charges.find((c) => c.id === "hc_fixture_due_soon")?.status).toBe("paid");
  // …and back on the list the line has left Pending for Paid.
  await page.goto(manager("/portal/payments/incoming/pending"));
  await expect(listRows(page)).toHaveCount(2);
  expect(await pendingTabCount(page)).toMatch(/Pending\s*2/);
  await expect(page.locator('[data-attr="payments-bucket-paid"]').first()).toContainText("2");
  await expect(page.locator("body")).not.toContainText(`Utilities — ${labels.thisMonthName}`);
  await shot(page, "10-list-after-record-payment", { fullPage: true });
  await page.goto(manager("/portal/payments/incoming/paid"));
  await expect(row(page, `Utilities — ${labels.thisMonthName}`)).toBeVisible();
  await shot(page, "11-paid-tab-after-record-payment", { fullPage: true });

  // Delete (the confirm stub answers yes) removes the charge from the mirror and the list.
  await page.goto(manager("/portal/payments/incoming/pending/hc_fixture_next_fee"));
  await expect(page.getByText("Drain repair (shared cost)").first()).toBeVisible();
  await page.locator('[aria-label="Delete"]').filter({ visible: true }).first().click();
  await expect.poll(() => {
    const last = server.writes.filter((w) => w.url === "/api/portal-household-charges" && (w.body as { action?: string })?.action === "replace").at(-1);
    const charges = (last?.body as { charges?: { id: string }[] } | null)?.charges ?? [];
    return charges.some((c) => c.id === "hc_fixture_next_fee");
  }).toBe(false);
  await page.waitForURL(/route=%2Fportal%2Fpayments%2Fincoming%2Fpending$/);
  await expect(listRows(page)).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("Drain repair (shared cost)");
  await shot(page, "12-list-after-delete", { fullPage: true });
  await note(
    "record-page-writes.json",
    server.writes
      .filter((w) => w.url === "/api/portal-household-charges")
      .map((w) => ({ method: w.method, action: (w.body as { action?: string })?.action, charges: (w.body as { charges?: { id: string; status: string }[] })?.charges?.map((c) => `${c.id}:${c.status}`) })),
  );
});

test("resident Payments: lands on Due, Upcoming is reachable and holds the ≤ 7-day charges, next month's rent is hidden", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(resident());
  const { labels } = server.seed;
  expect(labels.daysUntilNextRent).toBeGreaterThan(7);

  // Landing tab: something is overdue, so the resident opens on Due (704129296).
  const dueTab = page.locator('[data-attr="resident-payments-tab-overdue"]').first();
  const upcomingTab = page.locator('[data-attr="resident-payments-tab-pending"]').first();
  await expect(dueTab).toContainText("Due");
  await expect(dueTab).toContainText("1");
  await expect(page.locator("body")).toContainText("Late fee");
  await shot(page, "13-resident-lands-on-due", { fullPage: true });

  // …and that landing decision is made ONCE: picking Upcoming must stick.
  await expect(upcomingTab).toContainText("2");
  await upcomingTab.click();
  await expect(page.locator("body")).toContainText(`Utilities — ${labels.thisMonthName}`);
  await expect(page.locator("body")).toContainText("Drain repair (shared cost)");
  await expect(page.locator("body")).not.toContainText("Late fee");
  // Next month's rent is > 7 days out and was never surfaced, so it is hidden
  // from the resident on every tab — the manager-surfaced drain repair is not.
  await expect(page.locator("body")).not.toContainText(`Rent — ${labels.nextMonthName}`);
  await expect(page.locator("body")).not.toContainText("$1,850.00");
  await shot(page, "14-resident-upcoming-hides-next-month-rent", { fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "15-resident-upcoming-phone", { fullPage: true });
  expect(errors.filter((e) => !/portal-list-control-stack|publishable key/.test(e))).toEqual([]);
});
