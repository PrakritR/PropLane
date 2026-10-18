/**
 * Reviewer-visible visual evidence for comanager-number-1015 (2026-10-17): the
 * teammate's view of the WORKSPACE's work number.
 *
 * `tests/unit/evidence-claude1-teammate-number-1017.test.tsx`,
 * `tests/unit/evidence-claude1-teammate-vendor-text-1017.test.tsx` and
 * `tests/unit/evidence-claude1-teammate-settings-row-1017.test.tsx` render the REAL components in
 * jsdom and dump each surface's markup when `EVIDENCE_DIR` is set. That markup is only a DOM dump
 * until it is painted: this spec compiles the REAL Tailwind build from `src/app/globals.css`,
 * drops it beside the dumps as `app.css` (the stylesheet each dump already links) and screenshots
 * every surface in Chromium at desktop width.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-claude1-teammate-number-1017.test.tsx \
 *     tests/unit/evidence-claude1-teammate-vendor-text-1017.test.tsx \
 *     tests/unit/evidence-claude1-teammate-settings-row-1017.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/teammate-number-1017.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/teammate-number-1017/.shots");

const SURFACES = [
  "01-teammate-work-number-live",
  "02-teammate-work-number-not-ready",
  "03-teammate-work-number-none",
  "04-owner-work-number-live",
  "05-setup-nag-teammate",
  "06-setup-nag-owner",
  "07-compose-sms-hint-states",
  "08-vendor-record-teammate-text",
  "09-vendor-record-readonly-teammate-email",
  "10-teammate-settings-work-identity-ready",
  "11-teammate-settings-work-identity-not-ready",
];

test("every teammate work-number surface is painted with the real Tailwind build", async ({ page }) => {
  const cssPath = path.resolve("src/app/globals.css");
  const css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "app.css"), css, "utf8");

  const painted: string[] = [];
  for (const name of SURFACES) {
    const file = path.join(DIR, `${name}.html`);
    await access(file); // the vitest EVIDENCE_DIR pass must have run first
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`file://${file}`);
    await page.waitForLoadState("load");
    // The stylesheet is what makes the dump a picture: refuse an unstyled shot.
    const styled = await page.evaluate(
      () => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "",
    );
    expect(styled, `${name} painted without its stylesheet`).toBe(true);
    const out = `${name}.png`;
    await page.screenshot({ path: path.join(DIR, out), fullPage: true });
    painted.push(out);
  }

  console.log(`painted ${painted.length} shots into ${DIR}:\n  ${painted.join("\n  ")}`);
});
