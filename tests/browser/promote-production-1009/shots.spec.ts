/**
 * Reviewer-visible visual evidence for the 2026-10-09 production promote.
 *
 * The jsdom evidence harnesses (`tests/unit/evidence-*-1009.test.tsx` and
 * friends) render the REAL screens and, with `EVIDENCE_DIR` set, dump each
 * one's markup. That markup is only a DOM dump until it is painted: this spec
 * compiles the REAL Tailwind build from `src/app/globals.css`, drops it beside
 * the dumps as `app.css` (the stylesheet each one already links), and
 * screenshots every surface in Chromium at desktop and phone widths.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-*1009*  # markup
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/promote-production-1009.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/promote-production-1009/.shots");

// Phone-width surfaces: the rest are desktop screens.
const PHONE = new Set<string>([]);

test("every rendered 1009 surface is painted with the real Tailwind build and screenshotted", async ({
  page,
}) => {
  const cssPath = path.resolve("src/app/globals.css");
  const css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;

  // Each dump links `./app.css`; the harnesses write into the evidence root and
  // into `html/`, so both need the stylesheet beside them.
  const roots = [DIR, path.join(DIR, "html")];
  const surfaces: { name: string; file: string }[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    const html = entries.filter((e) => e.endsWith(".html"));
    if (html.length === 0) continue;
    await writeFile(path.join(root, "app.css"), css, "utf8");
    for (const file of html) surfaces.push({ name: file.replace(/\.html$/, ""), file: path.join(root, file) });
  }
  expect(surfaces.length, "no evidence markup found - run the EVIDENCE_DIR vitest pass first").toBeGreaterThan(0);

  const out = path.join(DIR, "png");
  await mkdir(out, { recursive: true });
  const painted: string[] = [];
  for (const { name, file } of surfaces) {
    const phone = PHONE.has(name);
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await page.goto(`file://${file}`);
    await page.waitForLoadState("load");
    // The stylesheet is what makes the dump a picture: refuse an unstyled shot.
    const styled = await page.evaluate(() => {
      const body = document.body;
      return getComputedStyle(body).fontFamily !== "" && document.styleSheets.length > 0;
    });
    expect(styled, `${name} painted without its stylesheet`).toBe(true);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    painted.push(name);
  }
  // eslint-disable-next-line no-console
  console.log(`painted ${painted.length} surfaces into ${out}:\n  ${painted.join("\n  ")}`);
});
