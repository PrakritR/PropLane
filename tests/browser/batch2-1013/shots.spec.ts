/**
 * Reviewer-visible visual evidence for batch 2 (2026-10-13).
 *
 * `tests/unit/evidence-bookings-notes-echo-1013.test.tsx` renders the REAL
 * manager Bookings panel, booking record and stay-details popup and, with
 * `EVIDENCE_DIR` set, dumps each one's markup. That markup is only a DOM dump
 * until it is painted: this spec compiles the REAL Tailwind build from
 * `src/app/globals.css`, drops it beside the dumps as `app.css` (the stylesheet
 * each dump already links), and screenshots each surface in Chromium — the
 * desktop calendar and the popups also at phone width, because the manager
 * reads them there too.
 *
 * Unlike the 1009 spec, the surface list is explicit: the same evidence
 * directory also holds text artifacts (a JSON-LD `<script>` fragment, the
 * llms.txt files) that are not pages and must not be painted.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-bookings-notes-echo-1013.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/batch2-1013.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/batch2-1013/.shots");

/** Page dumps only, with the widths each surface is actually read at. */
const SURFACES: { name: string; phone?: boolean }[] = [
  { name: "bookings-echo-remainder" },
  { name: "booking-record-notes-row" },
  { name: "booking-details-notes" },
  { name: "booking-details-notes", phone: true },
  { name: "host-block-notes-dialog" },
  { name: "host-block-notes-dialog", phone: true },
  { name: "host-block-remove-remainder" },
];

test("the real Bookings surfaces are painted with the real Tailwind build", async ({ page }) => {
  const cssPath = path.resolve("src/app/globals.css");
  const css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "app.css"), css, "utf8");

  const painted: string[] = [];
  for (const { name, phone } of SURFACES) {
    const file = path.join(DIR, `${name}.html`);
    await access(file); // the vitest EVIDENCE_DIR pass must have run first
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await page.goto(`file://${file}`);
    await page.waitForLoadState("load");
    // The stylesheet is what makes the dump a picture: refuse an unstyled shot.
    const styled = await page.evaluate(() => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "");
    expect(styled, `${name} painted without its stylesheet`).toBe(true);
    const out = `${name}${phone ? ".phone" : ""}.png`;
    await page.screenshot({ path: path.join(DIR, out), fullPage: true });
    painted.push(out);
  }

  console.log(`painted ${painted.length} shots into ${DIR}:\n  ${painted.join("\n  ")}`);
});
