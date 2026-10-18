/**
 * Paints the Add-room commit evidence (Oct 17: "commit the room form's draft on every exit but
 * Cancel"). `tests/unit/evidence-add-room-commit-1017.test.tsx` drives the REAL House details
 * panel through a manager's clicks and dumps each step; this drops the app's own compiled Tailwind
 * beside the dumps and screenshots them, then reads the last two back so the pictures are not the
 * only proof: the room survives the navigation, and Cancel still leaves no blank room behind.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-add-room-commit-1017.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/ui-sweep-1016.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/ui-sweep-1016/.shots");
const DESKTOP = { width: 1280, height: 900 };

const STEPS = [
  "13-add-room-before",
  "14-add-room-form-unsaved",
  "15-add-room-landed-on-bathrooms",
  "16-add-room-kept-after-navigation",
  "17-add-room-cancel-discards",
];

test("paints the Add-room flow, and reads back what the pictures claim", async ({ page }) => {
  await mkdir(DIR, { recursive: true });
  const cssPath = path.resolve("src/app/globals.css");
  await writeFile(
    path.join(DIR, "app.css"),
    (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css,
    "utf8",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(DESKTOP);

  const text: Record<string, string> = {};
  for (const step of STEPS) {
    const file = path.join(DIR, `${step}.html`);
    await access(file); // the vitest EVIDENCE_DIR pass must have run first
    await page.goto(`file://${file}`);
    await page.waitForLoadState("load");
    const styled = await page.evaluate(
      () => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "",
    );
    expect(styled, `${step} painted without its stylesheet`).toBe(true);
    text[step] = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: path.join(DIR, `${step}.png`), fullPage: true });
  }

  // The house starts with one room...
  expect(text["13-add-room-before"]).toContain("Room A");
  expect(text["13-add-room-before"]).not.toContain("Attic");
  // ...and after "+ Add bathroom" navigated the manager away mid-form, the room is on the house.
  expect(text["16-add-room-kept-after-navigation"]).toContain("Attic");
  // Cancel is still the exit that drops it, with no blank "Room 2" left behind.
  expect(text["17-add-room-cancel-discards"]).not.toContain("Scratch");
  expect(text["17-add-room-cancel-discards"]).not.toContain("Room 2");

  // eslint-disable-next-line no-console
  console.log(`painted the Add-room flow into ${DIR}:\n  ${STEPS.map((s) => `${s}.png`).join("\n  ")}`);
});
