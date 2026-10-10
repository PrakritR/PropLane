/**
 * Reviewer-visible visual evidence for the three 2026-10-09 surfaces the jsdom
 * evidence harnesses do not dump: the phone Filter sheet, the growth Engage
 * list and Vendor services.
 *
 * Bundles the REAL `WorkspaceProvider`, `PortalFilterSortSheet`,
 * `GrowthEngageTab` and `VendorServicesPanel` together with the REAL Tailwind
 * build and drives them in Chromium through request interception — no dev
 * server, accounts or database. Only session, navigation and analytics are
 * stubbed, so what the screenshots show is the surface an end user sees.
 *
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/promote-production-1009.config.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const SHOTS = path.join(
  process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/promote-production-1009/.shots"),
  "png",
);

let javascript: string;
let css: string;

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  const dir = path.resolve("tests/browser/promote-production-1009");
  const stubs = path.join(dir, "stubs.tsx");
  const shims = path.join(dir, "node-shims.ts");
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
  css =
    (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css + "\n" + fixtureCss;
});

/** Held until the spec releases it, so the Filter tap lands mid-read. */
let releaseWorkspaces: (() => void) | null = null;

test.beforeEach(async ({ page }) => {
  releaseWorkspaces = null;
  await page.route("http://production-1009.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "application/javascript", body: javascript });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-background text-foreground"><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
});

async function open(page: Page, surface: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  await page.goto(`http://production-1009.test/portal?surface=${surface}`);
  return errors;
}

// A real touch phone: `usePortalSurface` asks about the POINTER first, so the
// Filter opens as a bottom sheet only on a coarse-pointer device.
test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("the phone Filter sheet stays open through the first workspace answer", async ({ page }) => {
    // Registered first on purpose: Playwright matches the most recently added
    // route, so the workspaces handler below must win over this catch-all.
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
    // The workspace read is held open: the manager taps Filter inside the real
    // ~1s window, then the answer lands under the open sheet.
    await page.route("**/api/workspaces**", async (route) => {
      await new Promise<void>((resolve) => {
        releaseWorkspaces = resolve;
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          workspaces: [
            {
              id: "w1",
              name: "My workspace",
              ownerUserId: "mgr-1",
              owned: true,
              isDefault: true,
              propertyIds: [],
              propertyPermissions: {},
            },
          ],
          activeWorkspaceId: "w1",
        }),
      });
    });
    const errors = await open(page, "filter-sheet");

    const trigger = page.locator('[data-attr="properties-filter-open"]');
    await expect(trigger).toBeVisible();
    await trigger.tap();
    const sheet = page.locator('[data-slot="vaul-bottom-sheet"]');
    await expect(sheet).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "phone-filter-sheet-01-open.png") });

    // The workspace answer the sheet used to die on.
    await expect.poll(() => releaseWorkspaces !== null).toBe(true);
    releaseWorkspaces!();
    await page.waitForTimeout(1500);

    await expect(sheet).toBeVisible();
    // The fields the manager tapped Filter for are still on screen.
    await expect(sheet.locator("select")).toHaveCount(2);
    await expect(sheet.locator("select").first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "phone-filter-sheet-02-after-workspace-answer.png") });
    expect(errors).toEqual([]);
  });
});

test("the growth Engage list draws its rows, tallies and drafts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const items = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      forDate: "2026-10-09",
      source: "reddit",
      platform: "reddit",
      target: "r/Landlord: Late rent again, third month",
      url: "https://www.reddit.com/r/Landlord/comments/a/t/",
      why: "Asks how to handle a tenant who is late every month",
      draft: "Put the late fee in the lease and send the notice the day it is late.",
      status: "open",
      evidence: {},
      createdAt: "2026-10-09T08:00:00.000Z",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      forDate: "2026-10-09",
      source: "reddit",
      platform: "reddit",
      target: "r/Seattle: Rooming house rules in 2026?",
      url: "https://www.reddit.com/r/Seattle/comments/b/t/",
      why: "Room-by-room landlord asking about the new rules",
      draft: "Seattle counts each room as its own tenancy once there are separate leases.",
      status: "done",
      evidence: {},
      createdAt: "2026-10-09T08:05:00.000Z",
    },
  ];
  await page.route("**/api/admin/growth/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/engage"))
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ date: "2026-10-09", items }),
      });
    if (url.pathname.endsWith("/watchlist"))
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          watchlist: [{ id: "w-1", platform: "reddit", handle: "r/Landlord", kind: "subreddit", url: null, topic: null }],
        }),
      });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ keywords: [] }) });
  });
  const errors = await open(page, "engage");

  await expect(page.getByText("r/Landlord: Late rent again, third month")).toBeVisible();
  await expect(page.locator('[data-attr="growth-engage-row"]')).toHaveCount(2);
  await page.screenshot({ path: path.join(SHOTS, "growth-engage-list.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("Vendor services lists the outside marketplaces as plain links", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [] }) }),
  );
  const errors = await open(page, "vendor-services");

  await expect(page.getByText(/Thumbtack|TaskRabbit/).first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "vendor-services.png"), fullPage: true });
  expect(errors).toEqual([]);
});
