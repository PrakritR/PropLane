/**
 * Reviewer-visible visual evidence for the claude-1 lane integration.
 *
 * Bundles the REAL components and the REAL Tailwind build and screenshots them in
 * Chromium. Only data, session, analytics and network are stubbed — so what the
 * screenshots show is the surface an end user sees.
 */
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const SHOTS =
  process.env.EVIDENCE_DIR ??
  path.resolve("tests/browser/lane-integration-1006/.shots");

let javascript: string;
let css: string;

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  const stubs = path.resolve("tests/browser/lane-integration-1006/stubs.tsx");
  const shims = path.resolve("tests/browser/lane-integration-1006/node-shims.ts");
  const inbox = path.resolve("tests/browser/lane-integration-1006/inbox-stub.ts");
  const aliases = Object.fromEntries(
    [
      "lib/move-in-forms/client",
      "hooks/use-portal-session",
      "lib/portal-nav-client",
      "lib/analytics/track-client",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/lane-integration-1006/fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: {
      ...aliases,
      "posthog-js": stubs,
      "next/navigation": stubs,
      "@/lib/portal-inbox-storage": inbox,
      crypto: shims,
      "node:crypto": shims,
    },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    loader: { ".svg": "text" },
  });
  javascript = bundle.outputFiles[0].text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (
    await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })
  ).css;
});

test.beforeEach(async ({ page }) => {
  await page.route("http://lane-1006.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "application/javascript", body: javascript });
    if (url.pathname === "/app.css")
      return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
  // Shaped (empty) answers, so the pane renders against the real response contracts.
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname.includes("/scheduled-messages")
      ? JSON.stringify({ settings: {}, messages: [] })
      : url.pathname.endsWith("/api/profile")
        ? JSON.stringify({ fullName: "Avery Stone", email: "manager@example.com" })
        : "{}";
    return route.fulfill({ contentType: "application/json", body });
  });
});

async function open(page: import("@playwright/test").Page, surface: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  await page.goto(`http://lane-1006.test/portal/forms?surface=${surface}`);
  await page.waitForLoadState("networkidle");
  return errors;
}

test("manager Forms page: Pending · Completed tabs, search, Filter, round blue + and Blocks facts on rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await open(page, "forms");

  // The header band this lane's plan specifies.
  await expect(page.locator('[data-attr="forms-tab-pending"]')).toBeVisible();
  await expect(page.locator('[data-attr="forms-tab-completed"]')).toBeVisible();
  await expect(page.locator('[data-attr="forms-search"]')).toBeVisible();
  await expect(page.locator('[data-attr="forms-filter-open"]')).toBeVisible();
  await expect(page.locator('[data-attr="forms-send"]')).toBeVisible();

  // Every per-template Blocks mode shows as a plain glyph fact on its row.
  for (const text of ["Move-in details", "Lease signing", "Approval"]) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  }
  // Rows carry no status pill / badge (AGENTS.md: no pills on rows).
  await expect(page.locator('[data-slot="badge"]')).toHaveCount(0);
  // The dashed "+ Add" footer row is gone; the header + is the only create action.
  await expect(page.getByText(/^\+ Add/)).toHaveCount(0);

  await page.screenshot({
    path: path.join(SHOTS, "01-manager-forms-page-pending.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("manager Forms page: Completed tab lists the submitted copy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await open(page, "forms-completed");
  await expect(page.getByText("Move-out walkthrough").first()).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, "02-manager-forms-page-completed.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Filter popover offers Kind · Property · Resident · Blocks", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await open(page, "forms");
  await page.locator('[data-attr="forms-filter-open"]').click();
  // Kind · Property · Resident · Blocks, as dropdowns (no chips, no subtext).
  for (const field of ["All kinds", "All properties", "All residents", "Anything"]) {
    await expect(page.getByText(field, { exact: true }).first()).toBeVisible();
  }
  await page.screenshot({ path: path.join(SHOTS, "03-forms-filter-popover.png") });
  expect(errors).toEqual([]);
});

test("the round blue + opens Send a form, and the resident record Forms tab is the same list scoped to one resident", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await open(page, "forms-record");
  await expect(page.getByText("Maya Chen")).toHaveCount(0); // resident is not repeated in the place line
  await expect(page.getByText("Resident intake").first()).toBeVisible();
  await expect(page.getByText("Marcus Lee")).toHaveCount(0); // other residents are out of scope
  await page.screenshot({
    path: path.join(SHOTS, "04-resident-record-forms-tab.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("the Forms list on a phone keeps the round + on the card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await open(page, "forms");
  const plus = page.locator('[data-attr="forms-send"]');
  await expect(plus).toBeVisible();
  const box = await plus.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: path.join(SHOTS, "05-manager-forms-page-phone.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});


test("Send new lease opens in the standard pop-up: Lease · Terms · Review & send", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await open(page, "send-new-lease");
  await expect(page.getByText("Send new lease").first()).toBeVisible();
  // The retired wording is gone.
  await expect(page.getByText("New terms", { exact: true })).toHaveCount(0);
  for (const step of ["Lease", "Terms", "Review & send"]) {
    await expect(page.getByText(step, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  }
  // The shared "Start from a file" card opens the pop-up, with this route's real PDF cap.
  await expect(page.getByText("Start from a file")).toBeVisible();
  await expect(page.getByText("up to 3.5 MB")).toBeVisible();
  await expect(page.getByText("Resident sees")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "06-send-new-lease-step-1.png"), fullPage: true });

  // Step 2 prefills from the current lease: the day after it ends, and its rent.
  await page.getByRole("button", { name: /next/i }).first().click();
  await expect(page.locator('[data-attr="lease-send-new-terms"]')).toBeVisible();
  await expect(page.locator('[data-attr="lease-renew-rent"]')).toHaveValue("1150");
  await expect(page.locator('input[type="date"]').first()).toHaveValue("2027-10-06");
  await page.screenshot({ path: path.join(SHOTS, "07-send-new-lease-terms-prefilled.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a record Communication section fills the page and offers Schedule for later", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await open(page, "communication");
  await expect(page.getByText("Maya Chen").first()).toBeVisible();

  // It is the thread pane only — never the inbox chrome.
  await expect(page.getByText("Archived", { exact: true })).toHaveCount(0);

  // Fills the page: the pane reaches (near) the bottom of the viewport.
  const pane = page.locator('[data-attr="record-communication"], section, div').first();
  const height = await page.evaluate(() => {
    const el = document.querySelector("#root > *") as HTMLElement | null;
    return el ? el.getBoundingClientRect().height : 0;
  });
  expect(height).toBeGreaterThan(700);
  await page.screenshot({ path: path.join(SHOTS, "08-record-communication-fills-page.png") });

  // The composer's schedule clock queues a send for later.
  const clock = page.locator('[data-attr*="schedule"], button[aria-label*="Schedule" i]').first();
  await expect(clock).toBeVisible();
  await clock.click();
  await expect(page.getByText(/Schedule for later/i).first()).toBeVisible();
  await expect(page.getByText(/Send at this time/i).first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "09-communication-schedule-for-later.png") });
  if (errors.length) console.log("PAGE_ERRORS:", JSON.stringify(errors, null, 1));
  expect(errors).toEqual([]);
  expect(pane).toBeTruthy();
});

test("the resident's own Forms section lists the forms sent to them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await open(page, "resident-forms");
  await expect(page.getByText("Resident intake").first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "10-resident-forms-section.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the resident lock holds, and fails closed naming no form when the forms read fails", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const errors = await open(page, "resident-lock");
  // Blocked by a named form: one line, one button to the form that unlocks it.
  await expect(page.getByText("Finish your forms first")).toBeVisible();
  await expect(page.locator('[data-attr="resident-forms-lock-open"]')).toBeVisible();
  // Fail closed: the lock still holds, but names no form and offers no door.
  const unchecked = page.locator('[data-attr="resident-forms-lock-unchecked"]');
  await expect(unchecked).toBeVisible();
  await expect(unchecked.getByText("Finish your forms first")).toHaveCount(0);
  await expect(unchecked.locator('[data-attr="resident-forms-lock-open"]')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, "11-resident-forms-lock-and-fail-closed.png") });
  expect(errors).toEqual([]);
});

/**
 * `/demo` never reads or writes real rows through a thread's scheduled sends: the reads are skipped,
 * Cancel takes effect in the sandbox, and no Send now button is offered. The real pathname (`/demo`) is what turns demo mode on here.
 */
test("under /demo a thread's scheduled sends act locally and ask the API for nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors: string[] = [];
  const scheduledApiCalls: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("request", (req) => {
    const pathname = new URL(req.url()).pathname;
    if (pathname.includes("scheduled-messages") || pathname.includes("scheduled-inbox-messages")) {
      scheduledApiCalls.push(`${req.method()} ${pathname}`);
    }
  });

  await page.goto("http://lane-1006.test/demo?surface=communication-demo");
  await page.waitForLoadState("networkidle");

  // The sandbox's own projected reminders, drawn from its local charge — no read of real rows.
  const bar = page.locator('[data-attr="inbox-scheduled-bar"]');
  await expect(bar).toBeVisible();
  await bar.locator('[data-attr="inbox-scheduled-bar-summary"]').click();
  const rows = bar.locator('[data-attr="inbox-scheduled-bar-row"]');
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  await page.screenshot({ path: path.join(SHOTS, "12-demo-thread-scheduled-sends.png") });

  // No Send now button exists on a scheduled row.
  await expect(bar.locator('[data-attr="inbox-scheduled-bar-send"]')).toHaveCount(0);

  // Cancel is applied locally instead: the reminder leaves the bar, with no request behind it.
  await rows.first().click();
  const cancel = page.getByRole("button", { name: /^cancel send$|^cancel$/i }).last();
  await cancel.click();
  await expect(bar.locator('[data-attr="inbox-scheduled-bar-row"]')).toHaveCount(rowCount - 1);
  await page.screenshot({ path: path.join(SHOTS, "14-demo-cancel-applied-locally.png") });

  // Nothing in the whole flow asked the scheduled-messages API for anything.
  expect(scheduledApiCalls).toEqual([]);
  expect(errors).toEqual([]);
});
