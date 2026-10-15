/**
 * Reviewer-visible visual evidence for the team-notice fix (2026-10-14).
 *
 * `tests/unit/evidence-team-notices-1014.test.tsx` drives the REAL
 * `emitActionEvent` and renders the REAL inbox components, dumping each
 * surface's markup when `EVIDENCE_DIR` is set. That markup is only a DOM dump
 * until it is painted: this spec compiles the REAL Tailwind build from
 * `src/app/globals.css`, drops it beside the dumps as `app.css` (the
 * stylesheet each dump already links) and screenshots every surface in
 * Chromium, at desktop width and again at phone width — a manager reads their
 * Communication list and the Team chat on both.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-team-notices-1014.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/team-notices-1014.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/team-notices-1014/.shots");

/** Page dumps only (the directory also holds plain-text delivery transcripts). */
const SURFACES = [
  "01-communication-list-routine",
  "02-team-chat-routine",
  "03-communication-list-urgent",
  "04-derived-and-keyless",
];

test("every team-notice surface is painted with the real Tailwind build", async ({ page }) => {
  const cssPath = path.resolve("src/app/globals.css");
  const css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "app.css"), css, "utf8");

  const painted: string[] = [];
  for (const name of SURFACES) {
    const file = path.join(DIR, `${name}.html`);
    await access(file); // the vitest EVIDENCE_DIR pass must have run first
    for (const phone of [false, true]) {
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 });
      await page.goto(`file://${file}`);
      await page.waitForLoadState("load");
      // The stylesheet is what makes the dump a picture: refuse an unstyled shot.
      const styled = await page.evaluate(
        () => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "",
      );
      expect(styled, `${name} painted without its stylesheet`).toBe(true);
      const out = `${name}${phone ? ".phone" : ""}.png`;
      await page.screenshot({ path: path.join(DIR, out), fullPage: true });
      painted.push(out);
    }
  }

  console.log(`painted ${painted.length} shots into ${DIR}:\n  ${painted.join("\n  ")}`);
});
