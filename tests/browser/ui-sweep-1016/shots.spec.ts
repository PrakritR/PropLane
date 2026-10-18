/**
 * Reviewer-visible visual evidence for the Oct 16 portal sweep (studio plan codex-1/ui-sweep-1016).
 *
 * Two passes, both with the app's OWN Tailwind build:
 *
 *   1. `paints every dumped surface` — `tests/unit/evidence-ui-sweep-1016.test.tsx` renders the real
 *      screens in jsdom and dumps their markup when EVIDENCE_DIR is set. That markup is only a DOM
 *      dump until it is painted: this drops the compiled CSS beside the dumps as `app.css` (the
 *      stylesheet each dump already links) and screenshots each one at desktop and phone width.
 *      For the pop-ups it also MEASURES the panel, which is the decision itself: the frame fits its
 *      content instead of the old fixed 920 x 640 window, and a phone is still a full sheet.
 *   2. `a record header inlines its icons…` — the fold is a measurement, and jsdom measures every
 *      width as 0, so the REAL header and the REAL adaptive row are bundled and driven live.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-ui-sweep-1016.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/ui-sweep-1016.config.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/ui-sweep-1016/.shots");
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** dumped page → shot name → the width it is painted at (a pop-up dump already carries its presentation). */
const SURFACES: [string, string, "desktop" | "phone"][] = [
  ["01-popup-fit-customize-dashboard", "01-popup-fit-customize-dashboard", "desktop"],
  ["01b-popup-phone-sheet-customize-dashboard", "01b-popup-phone-sheet-customize-dashboard", "phone"],
  ["02-popup-fit-admin-compose", "02-popup-fit-admin-compose", "desktop"],
  ["02b-popup-phone-sheet-admin-compose", "02b-popup-phone-sheet-admin-compose", "phone"],
  ["03-inbox-failed-attachment-blocks-send", "03-inbox-failed-attachment-blocks-send", "desktop"],
  ["04-inbox-work-identity-boxes", "04-inbox-work-identity-boxes", "desktop"],
  ["05-inbox-work-identity-status-failed", "05-inbox-work-identity-status-failed", "desktop"],
  ["06-tour-rooms-one-monthly-price", "06-tour-rooms-one-monthly-price", "desktop"],
  ["06-tour-rooms-one-monthly-price", "06b-tour-rooms-one-monthly-price-phone", "phone"],
  ["07-tour-empty-state", "07-tour-empty-state", "desktop"],
  ["08-tour-read-failure-retry", "08-tour-read-failure-retry", "desktop"],
];

async function tailwindCss(): Promise<string> {
  const cssPath = path.resolve("src/app/globals.css");
  return (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
}

/** The pop-up panel's own box, as the browser lays it out. */
async function panelBox(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-slot="modal-radix-dialog"], [data-slot="modal-vaul-drawer"]');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return { height: Math.round(r.height), width: Math.round(r.width), viewport: window.innerHeight };
  });
}

test("paints every dumped surface, and measures the pop-ups", async ({ page }) => {
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "app.css"), await tailwindCss(), "utf8");
  await page.emulateMedia({ reducedMotion: "reduce" });

  const painted: string[] = [];
  const measured: string[] = [];
  for (const [dump, name, width] of SURFACES) {
    const file = path.join(DIR, `${dump}.html`);
    {
      const phone = width === "phone";
      await access(file); // the vitest EVIDENCE_DIR pass must have run first
      await page.setViewportSize(phone ? PHONE : DESKTOP);
      await page.goto(`file://${file}`);
      await page.waitForLoadState("load");
      // The dumps froze each pop-up's open animation at its first frame (vaul parks its sheet
      // below the fold until it has animated in); the components already honour motion-reduce,
      // so settle the transform and let them paint where a person sees them.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>("[data-vaul-drawer]")) {
          el.style.animation = "none";
          el.style.transition = "none";
          el.style.transform = "none";
        }
      });
      // The stylesheet is what makes a dump a picture: refuse an unstyled shot.
      const styled = await page.evaluate(
        () => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "",
      );
      expect(styled, `${name} painted without its stylesheet`).toBe(true);

      if (/^0[12]b?-popup/.test(name)) {
        const box = await panelBox(page);
        expect(box, `${name} has no pop-up panel`).not.toBeNull();
        if (phone) {
          // A phone is still the full sheet.
          expect(box!.height).toBeGreaterThan(box!.viewport * 0.8);
        } else {
          // The decision: the panel's height is its content's, under the 640 cap — never the
          // fixed 640 window every pop-up used to open as.
          expect(box!.height).toBeLessThan(640);
          expect(box!.height).toBeGreaterThan(120);
        }
        measured.push(`${name} (${width}): panel ${box!.width}x${box!.height} in a ${box!.viewport}px-tall viewport`);
      }

      const out = `${name}.png`;
      await page.screenshot({ path: path.join(DIR, out), fullPage: true });
      painted.push(out);
    }
  }
  // The generated lease is a standalone document with its own CSS — painted as the resident
  // reads it, and read back to prove the identity lines are not on the page at all.
  await page.setViewportSize(DESKTOP);
  await page.goto(`file://${path.join(DIR, "09-lease-room-no-birth-date.html")}`);
  await page.waitForLoadState("load");
  const leaseText = await page.evaluate(() => document.body.innerText);
  expect(leaseText).toContain("Jordan Lee");
  expect(leaseText).not.toMatch(/date of birth/i);
  expect(leaseText).not.toContain("123-45-6789");
  expect(leaseText).not.toContain("D1234567");
  // The wording fixes that ship with it.
  expect(leaseText).not.toMatch(/floor floor/i);
  expect(leaseText).toMatch(/written itemized statement of deductions/);
  await page.screenshot({ path: path.join(DIR, "09-lease-room-no-birth-date.png"), fullPage: true });
  painted.push("09-lease-room-no-birth-date.png");
  // ...and the deposit clause on its own: the sentence now finishes ("…or provide a written
  // itemized statement of deductions"), where the template used to print a fragment.
  // (The floor wording — "their room on the 2nd floor", never "2nd floor floor" — is pinned by
  // tests/unit/lease-compact-wording.test.ts; this fixture's room carries no floor label.)
  const deposit = page.locator("text=written itemized statement of deductions").first();
  await deposit.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(DIR, "09b-lease-deposit-sentence.png") });
  painted.push("09b-lease-deposit-sentence.png");

  console.log(`painted ${painted.length} shots into ${DIR}:\n  ${painted.join("\n  ")}`);
  console.log(`pop-up frames measured:\n  ${measured.join("\n  ")}`);
});

test.describe("the record header's action icons", () => {
  let javascript: string;
  let css: string;

  test.beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["tests/browser/ui-sweep-1016/header-fixture.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      alias: { crypto: path.resolve("tests/browser/ui-sweep-1016/node-crypto-stub.ts") },
      define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    });
    javascript = bundle.outputFiles[0]!.text;
    css = await tailwindCss();
  });

  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (error) => console.log("pageerror:", error.message));
    await page.route("http://ui-sweep-1016.test/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/fixture.js")
        return route.fulfill({ contentType: "application/javascript", body: javascript });
      if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/app.css"></head><body class="bg-background text-foreground"><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    });
  });

  test("inlines five icons on a desktop header and folds only when they do not fit", async ({ page }) => {
    await mkdir(DIR, { recursive: true });
    await page.emulateMedia({ reducedMotion: "reduce" });

    // Desktop: every one of the five actions is its own icon, and there is no ⋯.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("http://ui-sweep-1016.test/?actions=5");
    const header = page.locator("[data-portal-record-header-actions]");
    await expect(header).toBeVisible();
    for (const label of ["Edit", "Share", "Copy link", "Preview", "Delete"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await page.screenshot({ path: path.join(DIR, "10-record-header-five-icons-desktop.png") });

    // A phone header has no room for five: it folds into the ⋯, which carries a glyph per item.
    await page.setViewportSize(PHONE);
    await page.goto("http://ui-sweep-1016.test/?actions=5&title=Room%203%20%C2%B7%204709A%208th%20Ave%20NE");
    const more = page.getByRole("button", { name: "More actions" });
    await expect(more).toBeVisible();
    await page.screenshot({ path: path.join(DIR, "11-record-header-phone-folded.png") });
    await more.click();
    const items = page.getByRole("menuitem");
    await expect(items.first()).toBeVisible();
    const withGlyph = await page.evaluate(
      () => Array.from(document.querySelectorAll('[role="menuitem"]')).filter((i) => i.querySelector("svg")).length,
    );
    expect(withGlyph).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: path.join(DIR, "12-record-header-phone-menu-glyphs.png") });
  });
});
