/**
 * Central payments browser proof.
 *
 * Bundles the REAL `ResidentPaymentsPanel` and `PortalPayoutsSettingsPage` with
 * Tailwind and serves them through Playwright request interception — no dev
 * server, no accounts, no database, no Stripe. Only session / app-UI / Next
 * navigation / analytics are stubbed (shared with the payments-upcoming
 * fixture); every `/api/**` call is answered by the in-memory server below,
 * which records writes so the spec can assert what was NOT called.
 *
 * What it proves, end-user side:
 *
 *  - the resident pay surface offers BOTH slots the overhaul defines: a
 *    per-charge Pay on the row and the whole-cart "Pay all" in the header;
 *  - the pay modal's first step is a method pick — manual card vs in-app bank
 *    (ACH) — and NOTHING is claimed on the server until the resident presses
 *    "Continue with …": no `POST /api/stripe/household-charge-checkout` before
 *    that click, exactly one after it;
 *  - the manager's Balance & payouts page splits platform money the way central
 *    source arbitration books it: "Held pending bank" (captured on the PropLane
 *    platform, classified to this owner) alongside "Available to withdraw"
 *    (already transferred to the owner's Connect account), with the per-source
 *    movement history naming each leg;
 *  - the classified Withdraw sheet opens on the withdrawable figure and does not
 *    offer the held money.
 *
 *   npx playwright test --config tests/browser/central-payments.config.ts
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
import { applicationPaymentReceipt } from "../../../src/lib/application-payment-receipt";

/**
 * Both receipts the card renders are produced by the REAL resolver, not by a
 * hand-picked status: one application whose fee the central rail can state
 * exactly, and one carrying a second, ambiguous legacy charge row.
 */
const RECEIPTS = {
  "app-exact": applicationPaymentReceipt({
    applicationId: "app-exact", managerUserId: MANAGER_ID, propertyId: PROPERTY_ID,
    residentEmail: "maya@example.com",
    claim: {
      application_id: "app-exact", manager_user_id: MANAGER_ID, property_id: PROPERTY_ID,
      resident_email: "maya@example.com", charge_id: "hc_app_fee", status: "settled",
      promotion_status: null, stripe_session_id: "cs_exact", principal_cents: 4500,
      payer_total_cents: 4500,
    },
    exactCharges: [{
      id: "hc_app_fee", status: "paid",
      row_data: { amountLabel: "$45.00", stripeCheckoutSessionId: "cs_exact", paidAt: "2026-10-01T17:00:00.000Z" },
    }],
    ambiguousLegacyCharges: [],
    payments: [{ manager_user_id: MANAGER_ID, amount_cents: 4500, stripe_checkout_session_id: "cs_exact" }],
    refunds: [],
  }),
  "app-legacy": applicationPaymentReceipt({
    applicationId: "app-legacy", managerUserId: MANAGER_ID, propertyId: PROPERTY_ID,
    residentEmail: "sam@example.com",
    claim: null,
    exactCharges: [],
    // A historical application-fee row with no claim and no session: the rail
    // cannot attribute it, so the card must not assert money was received.
    ambiguousLegacyCharges: [{ id: "hc_legacy_fee", status: "paid", row_data: { amountLabel: "$45.00" } }],
    payments: [],
    refunds: [],
  }),
} as const;

const evidenceDir = process.env.EVIDENCE_DIR;
async function shot(page: Page, name: string, opts: Parameters<Page["screenshot"]>[0] = {}) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  // Let the modal/sheet entrance animations finish first - a frame caught
  // mid-fade reads as two overlapping screens to a reviewer.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
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
    entryPoints: ["tests/browser/central-payments/fixture.tsx"],
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

type Server = {
  seed: ReturnType<typeof buildSeed>;
  writes: { url: string; method: string; body: unknown }[];
  balance: Record<string, unknown>;
  destinations: Record<string, unknown>[];
};

/**
 * `/api/stripe/payouts/balance` as `snapshotWithPlatformHolds` composes it.
 * $1,250.00 was captured on the PropLane platform and classified to this owner
 * but has not moved to their Connect account yet (`heldCents`); $590.00 already
 * did and is what Stripe can actually pay out (`withdrawableCents`).
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
  await page.route("http://central-payments.test/**", (route) => {
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
      if (method === "GET") {
        return json(route, {
          charges: server.seed.charges,
          rentProfiles: server.seed.rentProfiles,
          viewerRole: page.url().includes("surface=payouts") ? "manager" : "resident",
        });
      }
      return json(route, { ok: true });
    }
    if (url.pathname === "/api/manager-applications") {
      if (method === "GET") return json(route, { rows: server.seed.applications });
      return json(route, { ok: true });
    }
    if (url.pathname === "/api/workspaces") {
      return json(route, {
        workspaces: [{
          id: "ws-fixture", name: "Magnolia workspace", ownerUserId: MANAGER_ID, owned: true, isDefault: true,
          propertyIds: [PROPERTY_ID], propertyNames: { [PROPERTY_ID]: "The Magnolia" },
          propertyPermissions: {}, livePropertyCount: 1,
        }],
        activeWorkspaceId: "ws-fixture",
        plan: null,
      });
    }
    const receiptMatch = /^\/api\/manager-applications\/([^/]+)\/receipt$/.exec(url.pathname);
    if (receiptMatch) {
      const receipt = RECEIPTS[decodeURIComponent(receiptMatch[1]!) as keyof typeof RECEIPTS];
      return receipt ? json(route, { receipt }) : json(route, { error: "No such application." }, 404);
    }
    if (url.pathname === "/api/stripe/payouts/balance") return json(route, server.balance);
    if (url.pathname === "/api/stripe/connect/bank-accounts") return json(route, { destinations: server.destinations });
    if (url.pathname === "/api/portal/proplane-balance") return json(route, { enabled: true });
    if (url.pathname.startsWith("/api/portal/manager-manual-payment-settings")) return json(route, { workspacePaymentSettings: {} });
    if (url.pathname.startsWith("/api/stripe/connect/status")) {
      return json(route, { connected: true, chargesEnabled: true, payoutsEnabled: true, paymentReady: true });
    }
    // The claim itself. The spec asserts WHEN this is reached, so answer it with
    // a shape the panel accepts rather than letting the catch-all swallow it.
    if (url.pathname === "/api/stripe/household-charge-checkout") {
      return json(route, { error: "Checkout is not available in this fixture." }, 503);
    }
    return json(route, { ok: true, records: [], rows: [], messages: [], items: [], settings: null, properties: [], applications: [], leases: [] });
  });
}

function fresh(): Server {
  return { seed: buildSeed(), writes: [], balance: payoutsBalance(), destinations: payoutDestinations() };
}

/**
 * Page errors, minus the Stripe.js publishable-key complaints: the bundle has
 * no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (there is no Stripe in this fixture by
 * design), and `loadStripe("")` logs about it on every mount of a surface that
 * can reach a card form. Nothing else is tolerated.
 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    if (/publishable key/i.test(e.message)) return;
    errors.push(e.message);
  });
  return errors;
}

const residentUrl = (route = "/resident/payments/pending") =>
  `http://central-payments.test/resident/payments?surface=resident&route=${encodeURIComponent(route)}`;
const payoutsUrl = () => `http://central-payments.test/portal/profile?surface=payouts`;
const receiptsUrl = () => `http://central-payments.test/portal/applications?surface=receipts`;

const checkoutClaims = (server: Server) =>
  server.writes.filter((w) => w.url === "/api/stripe/household-charge-checkout");

test("resident pay surface: per-charge Pay and whole-cart Pay all; the method step claims nothing until Continue", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(residentUrl("/resident/payments/overdue"));

  // Whole-cart slot: the header's "Pay all" covers every payable line.
  const payAll = page.locator('[data-attr="resident-payments-pay-all"]');
  await expect(payAll).toBeVisible();
  await shot(page, "01a-resident-list-whole-cart-pay-all", { fullPage: true });

  // Per-charge slot: the charge's own record page carries "Pay $50.00".
  await page.getByText("Late fee").first().click();
  const rowPay = page.locator('[data-attr="resident-payments-row-pay"]').first();
  await expect(rowPay).toBeVisible();
  await expect(rowPay).toHaveText(/Pay \$50\.00/);
  await shot(page, "01b-resident-charge-record-per-charge-pay", { fullPage: true });

  // Nothing has been claimed just by looking at the list.
  expect(checkoutClaims(server)).toHaveLength(0);

  await rowPay.click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Pay charges" }).first();
  await expect(dialog).toBeVisible();
  // Step one is the method pick: manual card vs in-app bank (ACH).
  await expect(dialog.locator('[data-attr="resident-payments-method-card"]')).toBeVisible();
  await expect(dialog.locator('[data-attr="resident-payments-method-ach"]')).toBeVisible();
  await shot(page, "02-resident-pay-modal-method-step-bank-selected");

  await dialog.locator('[data-attr="resident-payments-method-card"]').click();
  await shot(page, "03-resident-pay-modal-method-step-card-selected");
  // Picking a method is not a claim: still no server-side checkout.
  expect(checkoutClaims(server)).toHaveLength(0);

  // Only the explicit Continue claims.
  await dialog.locator('[data-attr="resident-payments-continue"]').click();
  await expect.poll(() => checkoutClaims(server).length).toBe(1);
  expect(checkoutClaims(server)[0]!.body).toMatchObject({ paymentMethod: "card", chargeIds: ["hc_central_overdue"] });
  await note("resident-checkout-claims.json", server.writes);
  await shot(page, "04-resident-pay-modal-after-continue");

  expect(errors).toEqual([]);
});

test("resident whole-cart Pay all claims every payable line in one checkout", async ({ page }) => {
  const server = fresh();
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(residentUrl("/resident/payments/pending"));

  await page.locator('[data-attr="resident-payments-pay-all"]').click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Pay charges" }).first();
  await expect(dialog).toBeVisible();
  await shot(page, "05-resident-pay-all-cart");
  expect(checkoutClaims(server)).toHaveLength(0);

  await dialog.locator('[data-attr="resident-payments-continue"]').click();
  await expect.poll(() => checkoutClaims(server).length).toBe(1);
  const claimed = (checkoutClaims(server)[0]!.body as { chargeIds: string[] }).chargeIds;
  expect([...claimed].sort()).toEqual(["hc_central_due_soon", "hc_central_overdue"]);
});

test("manager Balance & payouts: held-on-platform money is shown apart from withdrawable, and Withdraw offers only the withdrawable figure", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 1000 });
  await page.goto(payoutsUrl());

  await expect(page.getByText("Available to withdraw")).toBeVisible();
  await expect(page.getByText("Held pending bank")).toBeVisible();
  // The two legs of central source arbitration, as money the manager can read.
  await expect(page.getByText("$590.00").first()).toBeVisible();
  await expect(page.getByText("$1,250.00").first()).toBeVisible();
  // Per-source movement history names each leg exactly once: one title, then
  // the dated fact and the figure beside it.
  await expect(page.getByText("Captured", { exact: true })).toBeVisible();
  await expect(page.getByText("Moved to Stripe", { exact: true })).toBeVisible();
  await expect(page.getByText("Moved from PropLane to Stripe")).toHaveCount(0);
  await shot(page, "06-manager-payouts-held-vs-withdrawable", { fullPage: true });

  // The Withdraw sheet opens on the WITHDRAWABLE figure; the $1,250 still held
  // on the platform is not offered.
  await page.getByRole("button", { name: "Withdraw" }).first().click();
  const sheet = page.getByRole("dialog").filter({ hasText: "Withdraw" }).first();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox").first()).toHaveValue("590.00");
  await shot(page, "07-manager-withdraw-sheet-prefilled-withdrawable");

  expect(errors).toEqual([]);
});

test("application fee receipt: the central rail states the exact receipt; an ambiguous legacy row is marked for review instead of claiming money", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 620 });
  await page.goto(receiptsUrl());

  const exact = page.locator('[data-attr="receipt-exact"]');
  await expect(exact.getByText("Paid", { exact: true })).toBeVisible();
  await expect(exact.getByText("Amount received")).toBeVisible();
  await expect(exact.getByText("$45.00")).toBeVisible();
  await expect(exact.getByText("Paid on")).toBeVisible();

  const legacy = page.locator('[data-attr="receipt-legacy"]');
  await expect(legacy.getByText("Payment needs review")).toBeVisible();
  // "Amount recorded", never "Amount received" — the rail will not assert a
  // receipt it cannot attribute, and there is no "Paid on" date to correct.
  await expect(legacy.getByText("Amount recorded")).toBeVisible();
  await expect(legacy.getByText("Amount received")).toHaveCount(0);
  await expect(legacy.getByText("Paid on")).toHaveCount(0);

  await shot(page, "08-application-receipt-exact-vs-legacy-needs-review");
  await note("application-receipts.json", RECEIPTS);
  expect(errors).toEqual([]);
});

/**
 * The other half of the same history list: rows that are real withdrawals
 * (`kind: "payout"`) rather than platform source movements. They take the same
 * shape as the source rows — one title, one dated fact, one figure — and a
 * failed withdrawal still carries its ⋯ → Retry.
 */
test("manager payout history: a withdrawal row is one title and one dated fact, and a failed one keeps Retry", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  server.balance = {
    ...payoutsBalance(),
    history: [
      {
        id: "po_failed", kind: "payout", amountCents: 32_000, feeCents: 0, netCents: 32_000,
        method: "standard", status: "failed", destinationLast4: "6789", createdAt: "2026-10-03T17:00:00.000Z",
        arrivalDate: null, initiatedInApp: true, failureMessage: "Account closed", serviceLabel: null,
      },
      {
        id: "po_transit", kind: "payout", amountCents: 12_500, feeCents: 0, netCents: 12_500,
        method: "instant", status: "in_transit", destinationLast4: "6789", createdAt: "2026-10-01T17:00:00.000Z",
        arrivalDate: null, initiatedInApp: true, failureMessage: null, serviceLabel: null,
      },
    ],
  };
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 1000 });
  await page.goto(payoutsUrl());

  await expect(page.getByText("Standard payout · ····6789 · Failed")).toBeVisible();
  await expect(page.getByText("Instant payout · ····6789 · In transit")).toBeVisible();
  // The state is said once, in the title — never repeated beside the figure.
  await expect(page.getByText("in_transit")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Payout" })).toBeVisible();
  await shot(page, "09-manager-payout-history-rows", { fullPage: true });

  expect(errors).toEqual([]);
});
