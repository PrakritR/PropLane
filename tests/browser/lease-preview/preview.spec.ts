import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";
import path from "node:path";

let javascript: string;
let css: string;
test.beforeAll(async () => {
  const stubs = path.resolve("tests/browser/lease-preview/stubs.tsx");
  const aliases = Object.fromEntries(
    [
      "components/providers/app-ui-provider",
      "lib/lease-pipeline-storage",
      "lib/generated-lease",
      "lib/lease-assistant-context",
      "lib/lease-section-edit.client",
      "lib/manager-landlord-profile",
      "lib/rental-application/data",
      "lib/manager-listing-submission",
      "lib/property-lease-template-sync",
      "lib/axis-assistant/portal-assistant-context",
      "components/portal/modal-assistant-strip",
      "components/portal/uploaded-lease-pdf-preview",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/lease-preview/fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { ...aliases, "posthog-js": stubs },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  });
  javascript = bundle.outputFiles[0].text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (
    await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), {
      from: cssPath,
    })
  ).css;
});
test.beforeEach(async ({ page }) => {
  // Render the real Generate modal, editor, and CSS; replace only data/AI/network dependencies.
  await page.route("http://lease-preview.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: javascript,
      });
    if (url.pathname === "/app.css")
      return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 1440, height: 500 },
]) {
  test(`full lease is readable, reviewable, and saved at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("BROWSER ERROR", e.message);
    });
    await page.goto("http://lease-preview.test/");
    const iframe = page.locator('iframe[title="Lease visual editor"]');
    const frame = page.frameLocator('iframe[title="Lease visual editor"]');
    await expect(page.getByText("Loading lease preview…")).toBeHidden();
    await expect(
      frame.getByRole("heading", {
        name: "Residential lease regression fixture",
      }),
    ).toBeVisible();
    expect((await iframe.boundingBox())!.height).toBeGreaterThanOrEqual(180);
    const last = frame.locator("#lease-final-section");
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    const acknowledgment = page.locator(
      '[data-attr="lease-ai-review-acknowledgment"]',
    );
    await acknowledgment.check();
    await page.getByRole("button", { name: "HTML", exact: true }).click();
    const html = page.getByRole("textbox", { name: "Lease HTML editor" });
    await html.fill(
      (await html.inputValue()).replace("$1,500.00", "$1,650.00"),
    );
    await expect(acknowledgment).not.toBeChecked();
    await page.getByRole("button", { name: "Visual", exact: true }).click();
    await expect(
      frame.getByText("Rent: $1,650.00.", { exact: false }),
    ).toBeVisible();
    await expect(frame.locator("[data-disclosure-rule]")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await acknowledgment.check();
    await page
      .getByRole("button", { name: "Generate lease", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Saved lease review" }),
    ).toBeVisible();
    for (const title of ["Lease document", "Lease agreement"]) {
      const savedFrame = page.frameLocator(`iframe[title="${title}"]`);
      await expect(
        savedFrame.getByText("Rent: $1,650.00.", { exact: false }),
      ).toBeVisible();
      await savedFrame.locator("#lease-final-section").scrollIntoViewIfNeeded();
      await expect(savedFrame.locator("#lease-final-section")).toBeInViewport();
    }
    await page.getByRole("button", { name: "Reopen lease" }).click();
    await expect(
      frame.getByRole("heading", {
        name: "Residential lease regression fixture",
      }),
    ).toBeVisible();
    expect((await iframe.boundingBox())!.height).toBeGreaterThanOrEqual(180);
    expect(errors).toEqual([]);
  });
}

test("external updates and unrelated renders preserve visual editing and mode switches", async ({
  page,
}) => {
  await page.goto("http://lease-preview.test/?standalone=1");
  const frame = page.frameLocator('iframe[title="Lease visual editor"]');
  await expect(
    frame.getByRole("heading", {
      name: "Residential lease regression fixture",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "External document update" }).click();
  await expect(
    frame.getByText("Updated Resident", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Unrelated render/ }).click();
  const parties = frame.getByText("Updated Resident", { exact: false });
  await parties.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Visible edit survives.");
  await expect(page.getByTestId("current-html")).toContainText(
    "Visible edit survives.",
  );
  await page.getByRole("button", { name: "HTML", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Lease HTML editor" }),
  ).toContainText("Visible edit survives.");
  await page.getByRole("button", { name: "Visual", exact: true }).click();
  await expect(
    frame.getByText("Visible edit survives.", { exact: false }),
  ).toBeVisible();
});

test("typing in the visual editor does not resize it or reflow the review gate", async ({
  page,
}) => {
  await page.goto("http://lease-preview.test/");
  const iframe = page.locator('iframe[title="Lease visual editor"]');
  const frame = page.frameLocator('iframe[title="Lease visual editor"]');
  const hint = page.locator('[data-attr="lease-preview-review-hint"]');
  await expect(
    frame.getByRole("heading", {
      name: "Residential lease regression fixture",
    }),
  ).toBeVisible();
  // Scroll-invariant: the modal body may scroll, but the gate must not grow or
  // shrink the editor under the caret. `previewReady` drops for one frame per keystroke.
  const geometry = async () => {
    const editor = (await iframe.boundingBox())!;
    const gate = (await hint.boundingBox())!;
    return {
      editorHeight: editor.height,
      gateHeight: gate.height,
      gateToEditor: Math.round(editor.y - gate.y),
    };
  };
  await expect(hint).toBeAttached({ timeout: 2_000 });
  const before = await geometry();
  expect(before.editorHeight).toBeGreaterThanOrEqual(180);
  const parties = frame.getByText("Example Resident", { exact: false }).first();
  await parties.click();
  await page.keyboard.press("End");
  for (const chunk of [" One.", " Two.", " Three.", " Four."]) {
    await page.keyboard.type(chunk);
    await expect(hint).toBeAttached({ timeout: 2_000 });
    expect(await geometry()).toEqual(before);
  }
  await expect(
    frame.getByText("One. Two. Three. Four.", { exact: false }),
  ).toBeVisible();
  expect(await geometry()).toEqual(before);
});

test("changing the lease template invalidates the review and renders the new document", async ({
  page,
}) => {
  await page.goto("http://lease-preview.test/");
  const frame = page.frameLocator('iframe[title="Lease visual editor"]');
  await expect(
    frame.getByRole("heading", {
      name: "Residential lease regression fixture",
    }),
  ).toBeVisible();
  const acknowledgment = page.locator(
    '[data-attr="lease-ai-review-acknowledgment"]',
  );
  await acknowledgment.check();
  await page
    .getByRole("button", { name: "Lease type", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Short-term lease", exact: true })
    .click();
  await expect(
    frame.getByRole("heading", { name: "Short-term lease regression fixture" }),
  ).toBeVisible();
  await expect(acknowledgment).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Generate lease", exact: true }),
  ).toBeDisabled();
});
