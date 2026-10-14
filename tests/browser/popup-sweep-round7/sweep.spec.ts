/**
 * Round 7 of the portal pop-up sweep, in a real browser with the real Tailwind CSS: the REAL
 * `ManagerTaskFormModal`, `SendMoveInFormPopup` and `ServiceEditPopup` are bundled and screenshotted.
 * Only data providers, routing, analytics and the assistant strip are stubbed (`stubs.tsx`).
 *
 * What is asserted and captured:
 *  - Add task: Description carries a required mark, the "Saving schedules…" hint paragraph is gone,
 *    Checklist / Attachments labels carry no parenthetical, the footer shows only "Step n of N"
 *    (no grey readiness caption), and the save state says "Not saved yet" without naming the field.
 *  - Send a form: a one-step door with no step rail and no Cancel; Send sits on the right.
 *  - Edit service on a phone: the step heading that repeats the active tab is not drawn; desktop keeps it.
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const SHOTS = process.env.SWEEP_SHOT_DIR ?? path.resolve("tests/browser/popup-sweep-round7/shots");
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

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
      "lib/inspections/client",
      "lib/move-in-forms/client",
      "components/portal/pro-add-service-modal",
      "lib/axis-assistant/portal-assistant-context",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/popup-sweep-round7/fixture.tsx"],
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
  // The fixture is served over http (an insecure context), where Chromium withholds crypto.randomUUID.
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

async function open(page: Page, which: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto(`http://popup-sweep.test/?case=${which}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(400);
}

test("Add task marks the task's own words required and drops the hint and readiness caption", async ({ page }) => {
  await open(page, "task", DESKTOP);
  const dialog = page.getByRole("dialog");

  // The field's own required mark, beside the label the manager reads.
  const label = dialog.locator('label[for="manager-task-title"]');
  await expect(label).toContainText("Description");
  await expect(label.locator("span.text-rose-500")).toHaveText("*");
  await expect(dialog.locator("#manager-task-title")).toHaveJSProperty("required", true);

  // Touch the required field and empty it again: the save state says only that nothing is saved —
  // it does not repeat the field's name, because the mark beside the field already points at the fix.
  await dialog.locator("#manager-task-title").fill("Inspect unit");
  await dialog.locator("#manager-task-title").fill("");
  await expect(dialog.getByText("Not saved yet", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Needs a title/)).toHaveCount(0);

  // Every removed sentence.
  await expect(dialog.getByText(/Saving schedules the tour/)).toHaveCount(0);
  await expect(dialog.getByText(/appears on your calendar as a reminder block/)).toHaveCount(0);
  await expect(dialog.getByText(/Add a schedule or due date/)).toHaveCount(0);
  await expect(dialog.getByText(/\(optional\)/i)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/add-task-desktop-task-step.png` });

  // The Review step: the two long parentheticals are gone from the labels, and the trailing
  // "Saving …" paragraph under the fields with them.
  await dialog.locator("#manager-task-title").fill("Inspect unit");
  await dialog.locator('[data-attr="listing-v2-rail-review"]').click();
  await page.waitForTimeout(400);
  await expect(dialog.getByText(/one step per line/)).toHaveCount(0);
  await expect(dialog.getByText(/optional name first/)).toHaveCount(0);
  await expect(dialog.getByText("Checklist", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Attachments", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/add-task-desktop-details-step.png` });
});

test("Send a form is a one-step door: no rail, no Cancel, Send on the right", async ({ page }) => {
  await open(page, "sendform", DESKTOP);
  const dialog = page.getByRole("dialog");
  await expect(page.locator('[data-attr="move-in-form-send-popup"]')).toHaveAttribute("data-rail", "none");
  await expect(dialog.locator('nav[aria-label^="Listing"]')).toBeHidden();
  await expect(dialog.locator('[data-attr="move-in-form-send-cancel"]')).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  const send = dialog.locator('[data-attr="move-in-form-send"]');
  await expect(send).toBeVisible();
  const [sendBox, dialogBox] = [await send.boundingBox(), await dialog.boundingBox()];
  // Send sits on the right half of the door now that nothing is beside it.
  expect(sendBox!.x).toBeGreaterThan(dialogBox!.x + dialogBox!.width / 2);
  await page.screenshot({ path: `${SHOTS}/send-a-form-desktop.png` });
});

test("a phone step heading that repeats the active tab is not drawn; desktop keeps it", async ({ page }) => {
  await open(page, "service", PHONE);
  const dialog = page.getByRole("dialog");
  // The phone tab row names the step.
  await expect(dialog.getByRole("tab", { name: "Service", exact: true })).toBeVisible();
  // The heading with the same words is not drawn.
  const stepHeading = dialog.locator('h2:text-is("Service")');
  await expect(stepHeading).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/edit-service-phone-no-repeat.png` });

  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(300);
  await expect(stepHeading).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/edit-service-desktop-heading-kept.png` });
});
