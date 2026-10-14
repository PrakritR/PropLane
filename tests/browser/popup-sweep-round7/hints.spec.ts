/**
 * The rest of round 7, in a real browser with the real Tailwind CSS: the hint sentences the sweep
 * removed and the "(optional)" label suffixes, on the REAL `PromotionForm`, `HousePrintablesCard`
 * and `ManagerTaskFormModal` (tour). Only data providers, routing and analytics are stubbed.
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const SHOTS = process.env.SWEEP_SHOT_DIR ?? path.resolve("tests/browser/popup-sweep-round7/shots");
const DESKTOP = { width: 1280, height: 1000 };

let javascript: string;
let css: string;

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  const stubs = path.resolve("tests/browser/popup-sweep-round7/stubs.tsx");
  const aliases = Object.fromEntries(
    [
      "components/providers/app-ui-provider",
      "components/portal/modal-assistant-strip",
      "hooks/use-work-assignment-directory",
      "lib/manager-schedule-suggest.client",
      "lib/analytics/track-client",
      "components/portal/pro-add-service-modal",
      "lib/axis-assistant/portal-assistant-context",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/popup-sweep-round7/hints-fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { ...aliases, "posthog-js": stubs, "next/navigation": stubs },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  });
  javascript = bundle.outputFiles[0]!.text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
});

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.addInitScript(() => {
    if (!crypto.randomUUID)
      Object.defineProperty(crypto, "randomUUID", {
        value: () => "00000000-0000-4000-8000-" + String(Math.random()).slice(2, 14).padEnd(12, "0"),
      });
  });
  await page.route("http://popup-sweep.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "application/javascript", body: javascript });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
});

async function open(page: Page, which: string) {
  await page.setViewportSize(DESKTOP);
  await page.goto(`http://popup-sweep.test/?case=${which}`);
  await page.waitForTimeout(500);
}

test("the flyer builder's template tiles carry no description sentence under them", async ({ page }) => {
  await open(page, "promotion");
  const tiles = page.getByRole("radiogroup", { name: "Flyer template" });
  await expect(tiles).toBeVisible();
  await tiles.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  // Shot before the assertions so the same run on the base commit shows what the line used to look like.
  await page.screenshot({ path: `${SHOTS}/promotion-flyer-template-no-hint.png` });
  // The one-line description of the picked template used to sit under the tiles.
  await expect(page.getByText(/Circular hero photo, dotted accents/)).toHaveCount(0);
  await expect(page.getByText(/high-impact marketing style/)).toHaveCount(0);
});

test("the welcome sheet's Resident field label has no (optional) suffix", async ({ page }) => {
  await open(page, "printables");
  await page.getByText("Welcome sheet", { exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Resident", { exact: true })).toBeVisible();
  await page.waitForTimeout(500); // the modal fades in; shoot it settled
  await expect(dialog.getByText(/\(optional\)/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/welcome-sheet-resident-no-optional.png` });
});

test("Add task in tour mode drops the 'Saving schedules the tour' hint", async ({ page }) => {
  await open(page, "tourtask");
  const dialog = page.getByRole("dialog");
  // Task type is the shared combobox (a button + listbox), not a native <select>.
  await dialog.getByRole("button", { name: "Select…" }).first().click();
  await page.getByRole("option", { name: "Tour", exact: true }).click();
  await page.waitForTimeout(400);
  await expect(dialog.getByText("Guest name", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Saving schedules the tour/)).toHaveCount(0);
  await expect(dialog.getByText(/notify the guest or resident on the next screen/)).toHaveCount(0);
  await expect(dialog.getByText(/\(optional\)/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/add-task-tour-step.png` });
});
