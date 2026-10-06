/**
 * One shared preview pager, in a real browser: the application editor's "Applicant sees" and the
 * move-in form editor's "Resident sees" draw the same header ("Step n of N · <form name>"), the same
 * ‹ › icon buttons, and one whole section (or several short ones) per step. Opening a section or a
 * question in the middle column moves the preview to that step; the old text Previous / Next buttons
 * and the Section dropdown are gone. Screenshots land in PAGER_SHOTS when it is set.
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const shotDir = process.env.PAGER_SHOTS ?? "";
let javascript: string;
let css: string;

test.beforeAll(async () => {
  const stubs = path.resolve("tests/browser/preview-pager/stubs.tsx");
  // Only what is neither the pager nor an editor: analytics, routing, the assistant and PDF bytes.
  const aliases = Object.fromEntries(
    ["components/portal/modal-assistant-strip", "components/portal/uploaded-lease-pdf-preview"].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/preview-pager/fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { ...aliases, "posthog-js": stubs, "next/navigation": stubs },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  });
  javascript = bundle.outputFiles[0].text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
  if (shotDir) await mkdir(shotDir, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.route("http://preview-pager.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: javascript });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
});

/** The pane's header line, e.g. "Step 2 of 5 · Household application". */
const stepLabel = (page: Page, prefix: string) => page.locator(`[data-attr="${prefix}-step-label"]`).first();
/** The pane's own card, so a shot shows the pager and not the whole workspace. */
const pane = (page: Page, attr: string) => page.locator(`[data-attr="${attr}"]`).first();

async function shoot(page: Page, name: string, locator?: ReturnType<Page["locator"]>) {
  if (!shotDir) return;
  await (locator ?? page).screenshot({ path: path.join(shotDir, `${name}.png`) });
}

test("Applicant sees: whole sections per step, ‹ › arrows, and the editor re-aims it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto("http://preview-pager.test/?surface=application");
  const label = stepLabel(page, "application-preview");
  await expect(label).toBeVisible();
  const first = (await label.textContent()) ?? "";
  // "Step n of N · <form name>", named with the application the manager is editing.
  expect(first).toMatch(/^Step 1 of \d+ · Household application$/);
  const total = Number(/of (\d+)/.exec(first)![1]);
  expect(total).toBeGreaterThan(1);

  // Whole sections with their titles, never a single question on its own.
  const step = page.locator('[data-attr="application-preview-step"]').first();
  await expect(step.locator("h4")).not.toHaveCount(0);
  await shoot(page, "applicant-sees-step-1", pane(page, "application-preview-pane"));
  await shoot(page, "application-editor-full");

  const previous = page.getByRole("button", { name: "Previous step" }).first();
  const next = page.getByRole("button", { name: "Next step" }).first();
  // Disabled at the ends: nothing before step 1.
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  await next.click();
  await expect(label).toHaveText(`Step 2 of ${total} · Household application`);
  await expect(previous).toBeEnabled();
  await shoot(page, "applicant-sees-step-2", pane(page, "application-preview-pane"));

  // Walk to the last step: Next goes dead there.
  for (let at = 2; at < total; at += 1) await next.click();
  await expect(label).toHaveText(`Step ${total} of ${total} · Household application`);
  await expect(next).toBeDisabled();
  await shoot(page, "applicant-sees-last-step", pane(page, "application-preview-pane"));

  // Opening a section in the middle column moves the preview back to that section's step.
  await page.getByRole("button", { name: /^Questions / }).first().click();
  await page.locator('[data-attr="application-questions-editor-section-toggle-household"]').first().click();
  await expect(label).toHaveText(`Step 1 of ${total} · Household application`);
  await shoot(page, "applicant-sees-reaimed-household", pane(page, "application-preview-pane"));
  await shoot(page, "application-editor-questions-step");

  // The Preview step's text buttons and the Section dropdown are gone.
  await expect(page.locator('[data-attr="application-preview-previous"]')).toHaveCount(0);
  await expect(page.locator('[data-attr="application-preview-next"]')).toHaveCount(0);
  await expect(page.locator('[data-attr="application-preview-position"]')).toHaveCount(0);
  await expect(page.locator('[data-attr="application-preview-section"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Resident sees: the same pager, with short sections combined into one step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto("http://preview-pager.test/?surface=move-in");

  const label = stepLabel(page, "move-in-form-preview");
  await expect(label).toBeVisible();
  const first = (await label.textContent()) ?? "";
  expect(first).toMatch(/^Step 1 of \d+ · Intake form$/);
  const total = Number(/of (\d+)/.exec(first)![1]);

  const step = page.locator('[data-attr="move-in-form-preview-step"]').first();
  // Step 1 is the whole "About you" section, with its title and every one of its questions.
  await expect(step.getByRole("heading", { name: "About you" })).toBeVisible();
  await expect(step.getByText("Legal name")).toBeVisible();
  await expect(step.getByText("Current address")).toBeVisible();
  await shoot(page, "resident-sees-step-1", pane(page, "move-in-form-live-preview"));
  await shoot(page, "move-in-editor-full");

  const next = page.getByRole("button", { name: "Next step" }).first();
  await expect(page.getByRole("button", { name: "Previous step" }).first()).toBeDisabled();
  await next.click();
  await expect(label).toHaveText(`Step 2 of ${total} · Intake form`);
  // Two short consecutive sections share this step, each keeping its own title.
  await expect(step.getByRole("heading", { name: "Emergency contact" })).toBeVisible();
  await expect(step.getByRole("heading", { name: "Vehicle and pets" })).toBeVisible();
  await shoot(page, "resident-sees-step-2-combined", pane(page, "move-in-form-live-preview"));

  // Opening the last section's question in the editor moves the preview to the step holding it.
  await page.locator('[data-attr^="move-in-questions-editor-section-toggle-"]').last().click();
  await page.locator('[data-attr="move-in-questions-editor-question-open"]').last().click();
  await expect(label).toHaveText(`Step ${total} of ${total} · Intake form`);
  await shoot(page, "resident-sees-reaimed-signature", pane(page, "move-in-form-live-preview"));
  expect(errors).toEqual([]);
});
