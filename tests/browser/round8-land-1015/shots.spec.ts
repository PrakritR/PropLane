/**
 * Reviewer-visible visual evidence for the round-8 landing (2026-10-15).
 *
 * `tests/unit/evidence-round8-resident-payments-1015.test.tsx`,
 * `tests/unit/evidence-round8-bookings-1015.test.tsx` and
 * `tests/unit/evidence-round8-resident-chrome-1015.test.tsx` render the REAL screens in jsdom and
 * dump each one's markup when `EVIDENCE_DIR` is set. That markup is only a DOM dump until it
 * is painted: this spec compiles the REAL Tailwind build from `src/app/globals.css`, drops it
 * beside the dumps as `app.css` (the stylesheet each dump already links) and screenshots every
 * surface in Chromium at desktop width, plus the resident ones again at phone width.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-round8-resident-payments-1015.test.tsx \
 *     tests/unit/evidence-round8-bookings-1015.test.tsx tests/unit/evidence-round8-resident-chrome-1015.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/round8-land-1015.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/round8-land-1015/.shots");

/** name → also shoot at phone width (the resident surfaces a resident reads on a phone). */
const SURFACES: [string, boolean][] = [
  ["01-resident-payments-due-labels", true],
  ["02-resident-payments-due-tab", true],
  ["03-resident-payments-pay-param-record", true],
  ["04-bookings-bar-popover", false],
  ["05-bookings-day-menu-reservation", false],
  ["06-bookings-day-menu-named-hold", false],
  ["07-bookings-delete-reservation-dialog", false],
  ["08-bookings-cancel-booking-dialog", false],
  ["09-bookings-edit-sheet-reservation", false],
  ["10-bookings-edit-sheet-named-booking", false],
  ["11-bookings-record-header-airbnb", false],
  ["12-resident-more-sheet-locks", true],
  ["13-resident-compact-tracker", true],
];

test("every round-8 surface is painted with the real Tailwind build", async ({ page }) => {
  const cssPath = path.resolve("src/app/globals.css");
  const css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "app.css"), css, "utf8");

  const painted: string[] = [];
  for (const [name, alsoPhone] of SURFACES) {
    const file = path.join(DIR, `${name}.html`);
    await access(file); // the vitest EVIDENCE_DIR pass must have run first
    for (const phone of alsoPhone ? [false, true] : [false]) {
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 });
      // The dumps carry Radix's open animation mid-flight; the components already honour
      // `motion-reduce`, so ask for it and they paint settled instead of half faded in.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`file://${file}`);
      await page.waitForLoadState("load");
      // The stylesheet is what makes the dump a picture: refuse an unstyled shot.
      const styled = await page.evaluate(
        () => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "",
      );
      expect(styled, `${name} painted without its stylesheet`).toBe(true);
      // A Radix pop-over parks itself off-screen (translate(0,-200%)) until it has measured its
      // anchor; a static dump never gets that second pass. Chromium has real rects, so anchor each
      // one under the trigger it names, exactly where a manager sees it open.
      await page.evaluate(() => {
        for (const wrapper of document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper]")) {
          const content = wrapper.firstElementChild as HTMLElement | null;
          const triggerId = content?.getAttribute("aria-labelledby");
          const trigger = triggerId ? document.getElementById(triggerId) : null;
          if (!content || !trigger) continue;
          // The dump froze the open animation at its first frame; settle it.
          content.style.animation = "none";
          content.style.opacity = "1";
          const anchor = trigger.getBoundingClientRect();
          wrapper.style.transform = "none";
          wrapper.style.position = "fixed";
          wrapper.style.top = `${anchor.bottom + 6}px`;
          wrapper.style.left = `${Math.max(8, anchor.right - content.getBoundingClientRect().width)}px`;
          wrapper.style.zIndex = "10060";
        }
      });
      const out = `${name}${phone ? ".phone" : ""}.png`;
      await page.screenshot({ path: path.join(DIR, out), fullPage: true });
      painted.push(out);
    }
  }

  console.log(`painted ${painted.length} shots into ${DIR}:\n  ${painted.join("\n  ")}`);
});
