/**
 * Reviewer-visible visual evidence for the promo-code / service work-email lane: the Communication work-email
 * box with its new Edit pencil, the Work email dialog, Settings → Leasing → Waive codes with a read-only row,
 * and a listing's Promo codes ⋯ menu for a code the viewer may not change.
 *
 * No dev server, account or database: the jsdom harness renders the REAL components and dumps their markup when
 * EVIDENCE_DIR is set; this drops the app's own compiled Tailwind beside the dumps as `app.css` (the stylesheet
 * each dump already links) and paints every surface at the width a person reads it.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-promo-codes-work-email-1030.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/promo-work-email-1030.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/promo-work-email-1030/.shots");
const DESKTOP = { width: 1280, height: 900 };

const SURFACES = [
  "10-work-email-card-edit",
  "11-work-email-dialog-available",
  "20-settings-waive-codes",
  "21-form-promo-codes-menu",
];

async function tailwindCss(): Promise<string> {
  const cssPath = path.resolve("src/app/globals.css");
  return (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
}

test("paints every dumped promo-code / work-email surface", async ({ page }) => {
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "app.css"), await tailwindCss(), "utf8");
  await page.emulateMedia({ reducedMotion: "reduce" });

  const painted: string[] = [];
  for (const name of SURFACES) {
    const file = path.join(DIR, `${name}.html`);
    await access(file); // the vitest EVIDENCE_DIR pass must have run first
    await page.setViewportSize(DESKTOP);
    await page.goto(`file://${file}`);
    await page.waitForLoadState("load");
    // The dumps froze each pop-up's open animation at its first frame; the components honour
    // motion-reduce, so settle the transform and let them paint where a person sees them.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-vaul-drawer]")) {
        el.style.animation = "none";
        el.style.transition = "none";
        el.style.transform = "none";
      }
      // Radix positions a dropdown from live measurements the dump never had, so an unplaced menu lands in the
      // page's top-left corner. Put it back under the ⋯ it belongs to, which is where a person reads it.
      const trigger = document.querySelector<HTMLElement>('[data-attr="form-promo-code-menu"]');
      for (const el of document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper]")) {
        el.style.animation = "none";
        el.style.transition = "none";
        el.style.transform = "none";
        if (!trigger) continue;
        const box = trigger.getBoundingClientRect();
        el.style.position = "absolute";
        el.style.top = `${box.bottom + window.scrollY + 4}px`;
        el.style.left = `${box.right + window.scrollX - 160}px`;
      }
    });
    // The stylesheet is what makes a dump a picture: refuse an unstyled shot.
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
