/**
 * Reviewer-visible visual evidence for the admin-team lane (plan admin-team-1027). The jsdom harness
 * tests/unit/evidence-admin-team-1027.test.tsx renders the REAL components and dumps their markup when EVIDENCE_DIR is
 * set; this compiles the app's own Tailwind beside the dumps as app.css and screenshots each surface:
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-admin-team-1027.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/admin-team-1027.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/admin-team-1027/.shots");
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1680, height: 900 };

/** dumped page → the width it is painted at (a phone door is read on a phone). */
const SURFACES: [string, "desktop" | "phone" | "wide"][] = [
  ["10-admin-team-pane", "desktop"],
  ["11-admin-team-invite-overall", "desktop"],
  ["12-admin-team-invite-workspace-role", "desktop"],
  ["13-admin-team-change-role", "desktop"],
  ["20-managed-by-proplane-combine", "desktop"],
  ["21-managed-by-proplane-pick", "desktop"],
  ["30-settings-scope-switcher", "desktop"],
];

async function tailwindCss(): Promise<string> {
  const cssPath = path.resolve("src/app/globals.css");
  return (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
}

test("paints every dumped admin-team surface", async ({ page }) => {
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "app.css"), await tailwindCss(), "utf8");
  await page.emulateMedia({ reducedMotion: "reduce" });

  const painted: string[] = [];
  for (const [name, width] of SURFACES) {
    const file = path.join(DIR, `${name}.html`);
    await access(file); // the vitest EVIDENCE_DIR pass must have run first
    await page.setViewportSize(width === "phone" ? PHONE : width === "wide" ? WIDE : DESKTOP);
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
    });
    // An open dropdown was positioned by script from jsdom's all-zero layout (width 0, top-left); re-seat it under its trigger.
    await page.evaluate(() => {
      const trigger = document.querySelector<HTMLElement>('[data-attr="settings-scope-select"]');
      const menu = document.querySelector<HTMLElement>("[data-field-select-menu]");
      if (!trigger || !menu) return;
      const box = trigger.getBoundingClientRect();
      Object.assign(menu.style, { top: `${box.bottom + 4}px`, left: `${box.left}px`, width: `${box.width}px` });
    });
    // The stylesheet is what makes a dump a picture: refuse an unstyled shot.
    const styled = await page.evaluate(() => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "");
    expect(styled, `${name} painted without its stylesheet`).toBe(true);
    const out = `${name}.png`;
    await page.screenshot({ path: path.join(DIR, out), fullPage: true });
    painted.push(out);

  }
  console.log(`painted ${painted.length} shots into ${DIR}:\n  ${painted.join("\n  ")}`);
});
