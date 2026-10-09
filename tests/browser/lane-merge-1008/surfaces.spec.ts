/**
 * Reviewer-visible visual evidence for the 2026-10-08 lane merge.
 *
 * Bundles the REAL Reel studio, the REAL Remotion `Reel` composition, the REAL
 * service record and the REAL inbox avatar with the REAL Tailwind build, and drives
 * them in Chromium. Only session, navigation, analytics, the local stores and the
 * network are stubbed — so what the screenshots show is the surface an end user sees.
 *
 * What it proves, each of which the jsdom tests can only assert as values:
 *
 *  - Reel studio: removing a scene re-flows the timeline contiguously AND every
 *    survivor keeps its OWN clip (assets keyed on the scene's stable id);
 *  - the rendered reel: a voice track longer than the scenes holds the LAST SCENE,
 *    and the end card is clamped to the final `endCardMs`;
 *  - the service record header: Edit, ONE red trash and the next step — no Message;
 *  - phone inbox tiles: a number-only contact gets a phone glyph, not "+(".
 *
 * `npm run test:lane-merge`. Set EVIDENCE_DIR=<dir> to write the screenshots
 * somewhere a reviewer can read them.
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const SHOTS = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/lane-merge-1008/.shots");
const HOST = "http://lane-merge-1008.test";

/** Distinct real product shots, so each scene's thumbnail is visibly its own. */
const MEDIA: Record<string, string> = {
  "clip-dashboard.webp": "public/marketing/product/dashboard.webp",
  "clip-inbox.webp": "public/marketing/product/phone-inbox.webp",
  "clip-tasks.webp": "public/marketing/product/phone-tasks.webp",
};

let javascript: string;
let css: string;

/* ── Shaped admin Money answers, against the real response contracts ──────── */
const monthKey = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(d);
const NOW = new Date();
const THIS_MONTH = monthKey(NOW);
const MONTHS_BACK = (n: number) => monthKey(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, 15)));

const revenueRow = (over: Record<string, unknown>) => ({
  source: "stripe",
  created: new Date(Date.now() - 86_400_000).toISOString(),
  email: null,
  accountId: null,
  accountName: null,
  feeCents: 0,
  currency: "usd",
  stripePath: null,
  payout: null,
  chargeId: null,
  invoiceId: null,
  hostedInvoiceUrl: null,
  stripeCustomerId: null,
  description: null,
  ...over,
});

const REVENUE_PAGE = {
  month: THIS_MONTH,
  rows: [
    revenueRow({ id: "txn_1", category: "subscriptions", title: "Pro monthly", email: "mia@example.com", accountId: "mgr-abc", accountName: "Mia Manager", grossCents: 4900, feeCents: 172, netCents: 4728, stripePath: "/payments/py_1" }),
    revenueRow({ id: "txn_2", category: "numbers", title: "PropLane Number", email: "dana@example.com", grossCents: 500, feeCents: 45, netCents: 455 }),
    revenueRow({ id: "txn_3", category: "credits", title: "Communication credit pack", email: "sam@example.com", grossCents: 2500, feeCents: 103, netCents: 2397 }),
    revenueRow({ id: "fee:led_9", source: "ledger", category: "service_fees", title: "Vendor service fee", grossCents: 1200, feeCents: 0, netCents: 1200 }),
    revenueRow({ id: "txn_4", category: "refunds", title: "Refund - Pro monthly", email: "lee@example.com", grossCents: -4900, feeCents: 0, netCents: -4900 }),
  ],
  total: 5,
  page: 1,
  pageSize: 25,
  summary: {
    grossCents: 9100,
    stripeFeesCents: 320,
    refundsCents: 4900,
    netCents: 3880,
    earnedCents: 4200,
    byCategory: { subscriptions: 4900, credits: 2500, numbers: 500, service_fees: 1200 },
  },
  counts: { all: 5, subscriptions: 1, credits: 1, numbers: 1, service_fees: 1, payouts: 0, refunds: 1 },
  truncated: false,
  testMode: false,
  nextPayout: null,
  generatedAt: new Date().toISOString(),
};

const subscriber = (over: Record<string, unknown>) => ({
  source: "stripe",
  since: "2026-06-01T00:00:00.000Z",
  trialEndsAt: null,
  trialDaysLeft: null,
  promoCode: null,
  stripeSubscriptionId: "sub_1",
  stripeCustomerId: "cus_1",
  renewsAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const SUBSCRIBERS_PAGE = {
  rows: [
    subscriber({ id: "mgr-abc", accountKey: "manager-mgr-abc", email: "mia@example.com", name: "Mia Manager", bucket: "paid", tier: "pro", planLabel: "Pro monthly", monthlyCents: 4900 }),
    subscriber({ id: "mgr-def", accountKey: "manager-mgr-def", email: "dana@example.com", name: "Dana Owner", bucket: "trial", tier: "pro", planLabel: "Pro trial", monthlyCents: null, trialEndsAt: "2026-10-10", trialDaysLeft: 2, source: "staff" }),
    subscriber({ id: "mgr-ghi", accountKey: "manager-mgr-ghi", email: "sam@example.com", name: "Sam Complimentary", bucket: "complimentary", tier: "business", planLabel: "Business annual", monthlyCents: null, promoCode: "FOUNDER50", source: "staff", stripeSubscriptionId: null }),
  ],
  counts: { all: 3, paid: 1, trial: 1, complimentary: 1, free: 0, canceled: 0 },
  total: 3,
  page: 1,
  pageSize: 25,
  generatedAt: new Date().toISOString(),
};

const pnlMonth = (month: string, over: Record<string, number> = {}) => ({
  month,
  streams: { subscriptions: 49_000, credits: 12_500, numbers: 3500, serviceFees: 8400, ...over },
  refundsCents: 4900,
  stripeFeesCents: 2480,
  unclassifiedCents: 0,
});

const PLATFORM_PNL = {
  currentMonth: THIS_MONTH,
  months: [MONTHS_BACK(2), MONTHS_BACK(1), THIS_MONTH].map((m) => pnlMonth(m)),
  revenueAvailable: true,
  revenueTruncated: false,
  testMode: false,
};

/** The Spreadsheets section: one live Google-Sheets link and one published-CSV link. */
const SHEET_LINKS = {
  sheets: { connected: true, email: "ops@proplane.test", configured: true },
  links: [
    {
      id: "lnk-1",
      title: "Alder Row stays",
      spreadsheetId: "1AbCdEf",
      workspaceId: "ws-1",
      propertyId: "prop-1",
      autoSync: true,
      lastSyncedAt: new Date(Date.now() - 9 * 60_000).toISOString(),
      lastError: null,
      lastSummary: "18 stays - 3 houses - 12 rooms",
      linked: true,
      staysTab: { gid: "0", title: "Stays" },
      source: "google",
      csvUrl: null,
      mode: "stays",
      refreshMinutes: 15,
      houseTabCount: 3,
    },
    {
      id: "lnk-2",
      title: "Birch Court occupancy (published CSV)",
      spreadsheetId: "",
      workspaceId: "ws-1",
      propertyId: null,
      autoSync: false,
      lastSyncedAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
      lastError: null,
      lastSummary: "Raw table - 42 rows",
      linked: true,
      staysTab: null,
      source: "csv",
      csvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv",
      mode: "raw",
      refreshMinutes: null,
      houseTabCount: 0,
    },
  ],
};

const expense = (over: Record<string, unknown>) => ({
  currency: "usd",
  recurrence: "monthly",
  endsOn: null,
  receiptPath: null,
  note: "",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const EXPENSES = [
  expense({ id: "exp-1", category: "hosting", vendor: "Vercel", amountCents: 2000, spentOn: `${MONTHS_BACK(2)}-01` }),
  expense({ id: "exp-2", category: "database", vendor: "Supabase", amountCents: 2500, spentOn: `${MONTHS_BACK(2)}-01` }),
  expense({ id: "exp-3", category: "messaging", vendor: "Twilio", amountCents: 1800, spentOn: `${MONTHS_BACK(1)}-03` }),
  expense({ id: "exp-4", category: "ai_models", vendor: "Anthropic", amountCents: 9500, spentOn: `${THIS_MONTH}-02`, recurrence: "none" }),
];

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  const dir = path.resolve("tests/browser/lane-merge-1008");
  const stubs = path.join(dir, "stubs.tsx");
  const shims = path.join(dir, "node-shims.ts");
  // Only the session is stubbed. The local-first stores and navigation are the real
  // modules: localStorage and the stubbed `next/navigation` make them work in the browser.
  const aliases = Object.fromEntries(
    ["hooks/use-portal-session", "hooks/use-manager-user-id"].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: [path.join(dir, "fixture.tsx")],
    bundle: true,
    write: false,
    outdir: path.join(dir, ".bundle"),
    format: "iife",
    jsx: "automatic",
    alias: { ...aliases, "posthog-js": stubs, "next/navigation": stubs, crypto: shims, "node:crypto": shims },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    loader: { ".svg": "text", ".css": "css", ".woff2": "empty", ".woff": "empty", ".png": "dataurl", ".jpg": "dataurl" },
  });
  javascript = bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const fixtureCss = bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const cssPath = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css + "\n" + fixtureCss;
});

test.beforeEach(async ({ page }) => {
  await page.route(`${HOST}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "application/javascript", body: javascript });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    const media = MEDIA[url.pathname.replace("/media/", "")];
    if (url.pathname.startsWith("/media/") && media)
      return route.fulfill({ contentType: "image/webp", body: await readFile(path.resolve(media)) });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
  // Shaped answers, so every pane renders against the real response contracts.
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/admin/revenue") return json(REVENUE_PAGE);
    if (url.pathname === "/api/portal/sheet-link") return json(SHEET_LINKS);
    if (url.pathname === "/api/admin/subscribers") return json(SUBSCRIBERS_PAGE);
    if (url.pathname === "/api/admin/finances") return json(PLATFORM_PNL);
    if (url.pathname === "/api/admin/expenses") return json({ expenses: EXPENSES });
    if (url.pathname === "/api/admin/growth/video-status")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          clip: { driver: "veo", keyPresent: true },
          voice: { driver: "elevenlabs", keyPresent: true },
          estimatePerReelUsd: { clip: 0.9, voice: 0.08 },
        }),
      });
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
});

async function open(page: Page, surface: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  await page.goto(`${HOST}/portal?surface=${surface}`);
  await page.waitForLoadState("networkidle");
  return errors;
}

/** The "0.0-3.0s" span and the thumbnail source of every scene row, in order. */
async function sceneRows(page: Page) {
  return page.$$eval('[data-attr="admin-growth-reel-scene"]', (rows) =>
    rows.map((row) => ({
      title: row.querySelector("b")?.textContent?.trim() ?? "",
      span: Array.from(row.querySelectorAll("span")).map((s) => s.textContent?.trim() ?? "").find((t) => /\d+\.\d-\d+\.\ds/.test(t)) ?? "",
      text: row.querySelector("input")?.getAttribute("value") ?? (row.querySelector("input") as HTMLInputElement | null)?.value ?? "",
      media: row.querySelector("img,video")?.getAttribute("src") ?? "",
    })),
  );
}

test("Reel studio: removing a scene re-flows the timeline and keeps every clip with its own scene", async ({ page }) => {
  const errors = await open(page, "growth-reel-studio");
  await page.waitForSelector('[data-attr="admin-growth-reel-scene"]');

  const before = await sceneRows(page);
  expect(before.map((r) => r.span)).toEqual(["0.0-3.0s", "3.0-8.0s", "8.0-10.0s"]);
  expect(before.map((r) => r.media)).toEqual(["/media/clip-dashboard.webp", "/media/clip-inbox.webp", "/media/clip-tasks.webp"]);
  await page.screenshot({ path: path.join(SHOTS, "growth-reel-studio-before-remove.png"), fullPage: true });

  // Remove the FIRST scene: the survivors are renumbered 1..2.
  await page.locator('[data-attr="admin-growth-reel-remove"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-attr="admin-growth-reel-scene"]').length === 2);

  const after = await sceneRows(page);
  await page.screenshot({ path: path.join(SHOTS, "growth-reel-studio-after-remove.png"), fullPage: true });

  // The hole the removed scene left is closed: 0-5 s then 5-7 s, each keeping its own length.
  expect(after.map((r) => r.span)).toEqual(["0.0-5.0s", "5.0-7.0s"]);
  expect(after.map((r) => r.title)).toEqual(["Scene 1", "Scene 2"]);
  // And each survivor still shows ITS OWN clip - not the removed scene's.
  expect(after.map((r) => r.media)).toEqual(["/media/clip-inbox.webp", "/media/clip-tasks.webp"]);
  expect(after.map((r) => r.text)).toEqual(["Every message in one inbox.", "Nothing slips."]);
  expect(errors).toEqual([]);
});

test("the rendered reel holds the last scene over a longer voice track and clamps the end card", async ({ page }) => {
  const errors = await open(page, "reel-frames");
  await page.waitForSelector('[data-attr="reel-frame"]');
  // Remotion mounts each frame through a suspense boundary; give the still image a beat.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, "growth-reel-frames.png"), fullPage: true });

  // 12.6 s reel over 6 s of scenes: the end card owns only the last 2.5 s (from 10.1 s).
  // At t = 8.0 s the LAST SCENE is still on screen - before the fix the card covered it.
  const held = page.locator('[data-attr="reel-frame"][data-ms="8000"]');
  await expect(held.locator("img")).toHaveCount(1);
  await held.screenshot({ path: path.join(SHOTS, "growth-reel-frame-8s-last-scene-held.png") });
  const endCard = page.locator('[data-attr="reel-frame"][data-ms="11500"]');
  await endCard.screenshot({ path: path.join(SHOTS, "growth-reel-frame-11.5s-end-card.png") });
  expect(errors).toEqual([]);
});

test("the service record header is Edit, one red trash and the next step - never Message", async ({ page }) => {
  const errors = await open(page, "service-record");
  await page.waitForSelector("text=Kitchen sink leaking under the cabinet");
  await page.screenshot({ path: path.join(SHOTS, "service-record-header.png"), fullPage: true });

  const labels = await page.$$eval("button[aria-label], a[aria-label]", (nodes) =>
    nodes.map((n) => n.getAttribute("aria-label") ?? ""),
  );
  expect(labels).toContain("Edit");
  expect(labels.filter((l) => /^(Delete|Cancel service|Delete permanently)$/i.test(l)).length).toBeLessThanOrEqual(1);
  expect(labels.some((l) => /^Message$/i.test(l))).toBe(false);
  expect(errors).toEqual([]);
});

test("a number-only inbox contact gets a phone glyph tile, a person keeps initials", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await open(page, "inbox-avatars");
  await page.waitForSelector("[data-inbox-avatar-glyph]");
  await page.screenshot({ path: path.join(SHOTS, "inbox-phone-glyph-avatars.png"), fullPage: true });
  expect(await page.locator('[data-inbox-avatar-glyph="phone"]').count()).toBe(2);
  // The tiles themselves: a glyph for the two numbers, real initials for the two people.
  const tiles = await page.$$eval('[data-attr="avatar-tile"]', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));
  expect(tiles.some((t) => t.includes("+("))).toBe(false);
  expect(tiles).toContain("LQ");
  expect(tiles).toContain("ET");
  expect(errors).toEqual([]);
});

test("admin Money - Payments lists the platform Stripe rows with their tabs and totals", async ({ page }) => {
  const errors = await open(page, "admin-payments");
  await page.waitForSelector("text=Pro monthly");
  await page.screenshot({ path: path.join(SHOTS, "admin-money-payments.png"), fullPage: true });
  const body = await page.locator("body").innerText();
  for (const label of ["Subscriptions", "Credits", "Numbers", "Service fees", "Payouts", "Refunds"]) {
    expect(body).toContain(label);
  }
  expect(body).toContain("PropLane Number");
  expect(errors).toEqual([]);
});

test("admin Money - Subscribers shows the plan, a live trial and a complimentary account", async ({ page }) => {
  const errors = await open(page, "admin-subscribers");
  await page.waitForSelector("text=Mia Manager");
  await page.screenshot({ path: path.join(SHOTS, "admin-money-subscribers.png"), fullPage: true });
  const body = await page.locator("body").innerText();
  expect(body).toContain("Pro monthly");
  expect(body).toContain("Pro trial");
  expect(body).toContain("Sam Complimentary");
  expect(errors).toEqual([]);
});

test("admin Money - Finances draws the P&L from the platform expenses", async ({ page }) => {
  const errors = await open(page, "admin-finances");
  await page.waitForSelector("text=Anthropic");
  await page.screenshot({ path: path.join(SHOTS, "admin-money-finances.png"), fullPage: true });
  const body = await page.locator("body").innerText();
  expect(body).toContain("Vercel");
  expect(body).toContain("Supabase");
  expect(body).toContain("Twilio");
  expect(errors).toEqual([]);
});

test("Integrations - the Spreadsheets section lists each link with its live status and source", async ({ page }) => {
  const errors = await open(page, "integrations-spreadsheets");
  await page.waitForSelector("text=Alder Row stays");
  await page.screenshot({ path: path.join(SHOTS, "integrations-spreadsheets.png"), fullPage: true });
  const body = await page.locator("body").innerText();
  expect(body).toContain("Birch Court occupancy (published CSV)");
  expect(errors).toEqual([]);
});
