/**
 * PLAN-0916-0041 WS1+WS2 — browser regression for the manager availability
 * grid and its click-through edit dialog. Bundles the REAL
 * `PortalCalendarPanels` + Modal + Button + Tailwind CSS with esbuild and
 * serves it through request interception (no dev server, no accounts, no DB).
 * Only data providers / navigation / app-UI provider are stubbed.
 *
 * It mounts the panel the way the manager Calendar page does (`studioGrid`,
 * `availabilityKeysByKind`, `coManagerPeers`, one house), so what runs here is
 * the shared calendar a manager actually sees: three availability kinds, one
 * colour and initials per person, and the people row.
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

/** A phone opens the calendar on Agenda; switch it to Week through the real control. */
async function showWeekOnPhone(page: Page) {
  await page.locator('[data-attr="calendar-view-mode"]').filter({ visible: true }).first().click();
  await page.getByRole("option", { name: "Week", exact: true }).click();
}

/** Painted availability on the manager grid: one block per run, labelled by kind. */
const blocks = (page: Page) => page.locator('[data-attr="calendar-availability-block"]');
const block = (page: Page, text: string) => blocks(page).filter({ hasText: text });
const dialog = (page: Page) => page.locator(".modal-panel").first();
const written = (page: Page) => page.evaluate(() => (window as unknown as { __written?: Written }).__written ?? []);

type Fixture = {
  toursKey: string;
  servicesKey: string;
  tasksKey: string;
  mondayDs: string;
  wednesdayDs: string;
  thursdayDs: string;
  fridayDs: string;
  painted: string[];
  servicesPainted: string[];
  tasksPainted: string[];
};
type Written = { key: string; slots: string[] }[];

async function fixture(page: Page) {
  return (await page.evaluate(() => (window as unknown as { __fixture: Fixture }).__fixture)) as Fixture;
}

test("grid: three availability kinds, per-person colour + initials, shared people row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://calendar-fixture.test/");

  // Exactly three kinds exist (inspections and move-ins fold into Tasks), and
  // each painted run reads its own kind — never a bare "Open".
  await expect(page.locator('[data-attr="calendar-legend"]')).toContainText("Tours");
  await expect(page.locator('[data-attr="calendar-legend"]')).toContainText("Services");
  await expect(page.locator('[data-attr="calendar-legend"]')).toContainText("Tasks");
  await expect(page.locator('[data-attr="calendar-legend"]')).not.toContainText(/inspection|move/i);
  await expect(blocks(page)).toHaveCount(4);
  await expect(block(page, "Tours")).toHaveCount(2);
  await expect(block(page, "Services")).toHaveCount(1);
  await expect(block(page, "Tasks")).toHaveCount(1);
  await expect(block(page, "Services").first()).toContainText("9 – 10 am");
  await expect(block(page, "Tasks").first()).toContainText("12 – 1 pm");

  // Availability is shared with everyone on the workspace calendar: one row of
  // people, each with their own colour and initials, and every block says whose
  // it is. No opt-in — sharing is not a setting any more.
  const people = page.locator('[data-attr="calendar-people-row"]');
  await expect(people).toBeVisible();
  await expect(people).toContainText("You");
  await expect(people).toContainText("Jules Park");
  await expect(people.locator('[data-attr="calendar-person-toggle"]')).toHaveCount(2);
  await expect(blocks(page).first()).toContainText("YO");
  const colors = await people.locator('[data-attr="calendar-person-chip"]').evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).backgroundColor),
  );
  expect(colors).toHaveLength(2);
  expect(new Set(colors).size).toBe(2);

  // Each run carries its own small × — "Remove <kind> availability <hours>".
  await expect(page.locator('[aria-label="Remove Services availability 9 – 10 am"]')).toHaveCount(1);
  await expect(page.locator('[aria-label="Remove Tasks availability 12 – 1 pm"]')).toHaveCount(1);
  await shot(page, "01-grid-desktop", { fullPage: true });

  // Hiding a person on the row takes their hours off the grid.
  await people.locator('[data-attr="calendar-person-toggle"][data-person="fixture-manager"]').click();
  await expect(blocks(page)).toHaveCount(0);
  await shot(page, "02-grid-person-hidden");
  await people.locator('[data-attr="calendar-person-toggle"][data-person="fixture-manager"]').click();
  await expect(blocks(page)).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("click a block → the availability dialog is prefilled; Save rewrites the hours; Delete removes them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://calendar-fixture.test/");
  const fx = await fixture(page);

  await block(page, "10 – 11:30 am").first().click();
  await expect(dialog(page)).toContainText("Your availability");
  // Prefilled from the clicked run: its kind, its single date, its hours.
  await expect(dialog(page).locator('[data-attr="calendar-availability-kinds"]')).toHaveText("Tours");
  await expect(dialog(page).locator('[data-attr="calendar-availability-on"]')).toHaveText("A date");
  await expect(dialog(page).locator('[data-attr="calendar-availability-date"]')).toHaveValue(fx.mondayDs);
  await expect(dialog(page).locator('[data-attr="calendar-availability-from"]')).toHaveText(/10 am/);
  await expect(dialog(page).locator('[data-attr="calendar-availability-to"]')).toHaveText(/11:30 am/);
  await shot(page, "03-edit-dialog-prefilled");

  // Extend to noon (slot 24 exclusive) and save.
  await dialog(page).locator('[data-attr="calendar-availability-to"]').click();
  await page.getByRole("option", { name: "12 pm", exact: true }).click();
  await dialog(page).locator('[data-attr="calendar-availability-save"]').click();
  await expect(dialog(page)).toBeHidden();
  await expect.poll(async () => (await written(page)).at(-1)?.slots).toEqual(
    [
      `${fx.mondayDs}:20`,
      `${fx.mondayDs}:21`,
      `${fx.mondayDs}:22`,
      `${fx.mondayDs}:23`,
      `${fx.wednesdayDs}:28`,
      `${fx.wednesdayDs}:29`,
    ].sort(),
  );
  await expect(block(page, "10 am – 12 pm").or(block(page, "10 – 12 pm")).first()).toBeVisible();
  await shot(page, "04-grid-after-save", { fullPage: true });

  // Re-open and delete the block: Monday's tour hours go, Wednesday's stay.
  await block(page, "Tours").first().click();
  await dialog(page).locator('[data-attr="calendar-availability-delete"]').click();
  await expect(dialog(page)).toBeHidden();
  await expect.poll(async () => (await written(page)).at(-1)?.slots).toEqual(
    [`${fx.wednesdayDs}:28`, `${fx.wednesdayDs}:29`],
  );
  await expect(block(page, "Tours")).toHaveCount(1);
  await expect(block(page, "Tours").first()).toContainText("2 – 3 pm");
  await shot(page, "05-grid-after-delete", { fullPage: true });
  expect(errors).toEqual([]);
});

test("a services run is its own kind: editing it never touches the tours record", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://calendar-fixture.test/");
  const fx = await fixture(page);

  await block(page, "Services").first().click();
  await expect(dialog(page).locator('[data-attr="calendar-availability-kinds"]')).toHaveText("Services");
  await expect(dialog(page).locator('[data-attr="calendar-availability-date"]')).toHaveValue(fx.thursdayDs);
  await shot(page, "06-services-dialog-prefilled");
  await dialog(page).locator('[data-attr="calendar-availability-delete"]').click();
  await expect(dialog(page)).toBeHidden();

  // Services hours live under the per-manager services record, never the tours
  // key the public booking route reads — so only that key was written.
  await expect.poll(async () => (await written(page)).map((w) => w.key)).toEqual([fx.servicesKey]);
  expect((await written(page)).at(-1)!.slots).toEqual([]);
  await expect(block(page, "Services")).toHaveCount(0);
  await expect(block(page, "Tours")).toHaveCount(2);
  await expect(block(page, "Tasks")).toHaveCount(1);
  await shot(page, "07-grid-after-services-delete", { fullPage: true });
});

test("mobile: the week keeps all three kinds and the people row, and the dialog fits the phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://calendar-fixture.test/");
  // A phone opens on Agenda by design (`defaultManagerCalendarViewMode`).
  await showWeekOnPhone(page);
  await expect(block(page, "Tours")).toHaveCount(2);
  await expect(block(page, "Services")).toHaveCount(1);
  await expect(block(page, "Tasks")).toHaveCount(1);
  await expect(page.locator('[data-attr="calendar-people-row"]')).toBeVisible();
  await shot(page, "08-grid-mobile", { fullPage: true });

  await block(page, "Tasks").first().click();
  await expect(dialog(page)).toContainText("Your availability");
  await expect(dialog(page).locator('[data-attr="calendar-availability-kinds"]')).toHaveText("Tasks");
  const box = (await dialog(page).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  await shot(page, "09-edit-dialog-mobile");
  await dialog(page).locator('[data-attr="calendar-availability-delete"]').click();
  await expect(dialog(page)).toBeHidden();
  await expect.poll(async () => (await written(page)).at(-1)?.slots).toEqual([]);
  await expect(block(page, "Tasks")).toHaveCount(0);
  await shot(page, "10-grid-mobile-after-delete", { fullPage: true });
});
