/**
 * PLAN-0916-0041 WS1+WS2 — browser regression for the manager availability
 * grid and its click-through edit dialog. Bundles the REAL
 * `PortalCalendarPanels` + Modal + Button + Tailwind CSS with esbuild and
 * serves it through request interception (no dev server, no accounts, no DB).
 * Only data providers / navigation / app-UI provider are stubbed.
 *
 *   npx playwright test --config tests/browser/calendar-availability.config.ts
 *
 * Set EVIDENCE_DIR to also write reviewer screenshots there.
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const evidenceDir = process.env.EVIDENCE_DIR;
async function shot(page: Page, name: string, opts: Parameters<Page["screenshot"]>[0] = {}) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), ...opts });
}

let javascript: string;
let css: string;
test.beforeAll(async () => {
  const stubs = path.resolve("tests/browser/calendar-availability/stubs.tsx");
  const aliases = Object.fromEntries(
    [
      "components/providers/app-ui-provider",
      "lib/demo-admin-scheduling",
      "lib/rental-application/data",
      "lib/manager-calendar-tour-meetings",
      "hooks/use-manager-user-id",
      "hooks/use-work-assignment-directory",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/calendar-availability/fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { ...aliases, "next/navigation": stubs, "posthog-js": stubs, crypto: stubs },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  });
  javascript = bundle.outputFiles[0].text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
});

test.beforeEach(async ({ page }) => {
  await page.route("http://calendar-fixture.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "application/javascript", body: javascript });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ records: [], ok: true }) }),
  );
});

/** The grid renders once for the phone strip and once for the desktop week; CSS hides one. */
const cell = (page: Page, label: string) => page.locator(`[aria-label="${label}"]`).filter({ visible: true });

type Fixture = { mondayDs: string; wednesdayDs: string; painted: string[] };
type Written = { key: string; slots: string[] }[];

test("grid: 'Tours' label, 'N open' day headers, no floating ×, hover-only '+'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://calendar-fixture.test/");
  const fx = (await page.evaluate(() => (window as unknown as { __fixture: Fixture }).__fixture)) as Fixture;

  // Painted block reads the category ("Tours"), not "Open".
  const mondayCell = cell(page, `Open details for 10 am on ${fx.mondayDs}`);
  await expect(mondayCell).toBeVisible();
  await expect(mondayCell).toContainText("Tours");
  await expect(mondayCell).toContainText("10");
  await expect(page.locator("body")).not.toContainText(/\bOpen\b\s*\n?\s*10/);

  // The floating per-run × is gone.
  await expect(page.locator('[data-attr="calendar-remove-availability-slot"]')).toHaveCount(0);

  // Day headers say "N open" (never "0 EVENTS").
  await expect(page.locator("body")).toContainText("3 open");
  await expect(page.locator("body")).toContainText("2 open");
  await expect(page.locator("body")).not.toContainText(/0 events/i);

  // Empty cells carry a faint "+" and never the word "Add".
  const emptyCell = cell(page, `Add 9 am on ${fx.mondayDs}`);
  await expect(emptyCell).toBeVisible();
  await expect(emptyCell).toHaveText("+");
  await expect(page.locator("button", { hasText: /^Add$/ })).toHaveCount(0);

  await shot(page, "01-grid-desktop", { fullPage: true });
  expect(errors).toEqual([]);
});

test("click a block → edit dialog is the create form, prefilled; Save changes rewrites; Delete block removes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://calendar-fixture.test/");
  const fx = (await page.evaluate(() => (window as unknown as { __fixture: Fixture }).__fixture)) as Fixture;

  await cell(page, `Open details for 10 am on ${fx.mondayDs}`).click();
  const dialog = page.locator(".modal-panel");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Edit availability block");
  // No delete-only "half hour" picker any more.
  await expect(dialog.locator('[aria-label="Half hour to delete"]')).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete block" })).toBeVisible();
  // Prefilled from the clicked block: Monday only, 10:00 → 11:30, once.
  // The time pickers are the shared listbox `Select` (a trigger button whose
  // text is the picked value, options carry role="option").
  const startTrigger = dialog.locator('label:has-text("Start time") + div button[aria-haspopup="listbox"]');
  const endTrigger = dialog.locator('label:has-text("End time") + div button[aria-haspopup="listbox"]');
  await expect(dialog).toContainText("Mon · 10 am-11:30 am · this week only");
  await expect(startTrigger).toHaveText(/10 am/);
  await expect(endTrigger).toHaveText(/11:30 am/);
  await expect(dialog.getByRole("button", { name: "Mon", exact: true })).toHaveClass(/bg-primary/);
  await shot(page, "02-edit-dialog-prefilled");

  // Change end to 12:00 (slot 24) and save.
  await endTrigger.click();
  await page.getByRole("option", { name: /^12 pm$/ }).click();
  await expect(endTrigger).toHaveText(/12 pm/);
  await expect(dialog).toContainText("Mon · 10 am-12 pm · this week only");
  await shot(page, "03-edit-dialog-end-changed");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const written = (await page.evaluate(() => (window as unknown as { __written: Written }).__written)) as Written;
  const last = written.at(-1)!;
  expect(last.slots).toEqual(
    [`${fx.mondayDs}:20`, `${fx.mondayDs}:21`, `${fx.mondayDs}:22`, `${fx.mondayDs}:23`, `${fx.wednesdayDs}:28`, `${fx.wednesdayDs}:29`].sort(),
  );
  const toasts = await page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []);
  expect(toasts).toContain("Availability updated");
  await expect(cell(page, `Open details for 10 am on ${fx.mondayDs}`)).toContainText("10");
  await expect(page.locator("body")).toContainText("4 open");
  await shot(page, "04-grid-after-save", { fullPage: true });

  // Delete the Wednesday block from the dialog.
  await cell(page, `Open details for 2 pm on ${fx.wednesdayDs}`).click();
  await expect(dialog).toBeVisible();
  await shot(page, "05-edit-dialog-wednesday");
  await dialog.getByRole("button", { name: "Delete block" }).click();
  await expect(dialog).toBeHidden();
  const written2 = (await page.evaluate(() => (window as unknown as { __written: Written }).__written)) as Written;
  expect(written2.at(-1)!.slots).toEqual(
    [`${fx.mondayDs}:20`, `${fx.mondayDs}:21`, `${fx.mondayDs}:22`, `${fx.mondayDs}:23`].sort(),
  );
  await expect(page.locator("body")).toContainText("0 open");
  await shot(page, "06-grid-after-delete", { fullPage: true });
  expect(errors).toEqual([]);
});

test("day header appends '· N booked' only when a tour is booked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://calendar-fixture.test/?booked");
  const fx = (await page.evaluate(() => (window as unknown as { __fixture: Fixture }).__fixture)) as Fixture;
  // Monday: 3 painted half hours, one consumed by the booked tour → 2 open · 1 booked.
  await expect(page.locator("body")).toContainText("2 open · 1 booked");
  await expect(page.locator("body")).toContainText("2 open");
  await expect(page.locator("body")).not.toContainText(/0 events/i);
  await expect(cell(page, `Open details for 11 am on ${fx.mondayDs}`)).toContainText(/Sam Rivera|Tour/);
  await shot(page, "11-grid-with-booked-tour", { fullPage: true });
});

test("mobile: day strip reads 'N open' and the dialog fits the phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://calendar-fixture.test/");
  const fx = (await page.evaluate(() => (window as unknown as { __fixture: Fixture }).__fixture)) as Fixture;
  await expect(page.locator("body")).toContainText("3 open");
  await expect(page.locator("body")).not.toContainText(/0 events/i);
  await shot(page, "07-grid-mobile", { fullPage: true });
  await cell(page, `Open details for 10 am on ${fx.mondayDs}`).click();
  const dialog = page.locator(".modal-panel");
  await expect(dialog).toContainText("Edit availability block");
  await shot(page, "08-edit-dialog-mobile");
  // The actions sit below the fold on a phone; the dialog body must scroll to them.
  const save = dialog.getByRole("button", { name: "Save changes" });
  const del = dialog.getByRole("button", { name: "Delete block" });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await expect(del).toBeInViewport();
  await shot(page, "09-edit-dialog-mobile-actions");
  await del.click();
  await expect(dialog).toBeHidden();
  const written = (await page.evaluate(() => (window as unknown as { __written: Written }).__written)) as Written;
  expect(written.at(-1)!.slots).toEqual([`${fx.wednesdayDs}:28`, `${fx.wednesdayDs}:29`]);
  await expect(page.locator("body")).toContainText("0 open");
  await shot(page, "10-grid-mobile-after-delete", { fullPage: true });
});
