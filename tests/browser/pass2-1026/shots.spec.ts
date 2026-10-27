/**
 * Reviewer-visible visual evidence for the Oct 26 pass-2 lanes: phone sign-in (phone-signin-1026), the stay chat
 * and tour host-team thread (line-206-chat-1026 § A3/A4), and bookings across channels (bookings-channels-1026).
 *
 * Two passes, no dev server, account or database. The jsdom harnesses render the REAL screens and dump their
 * markup when EVIDENCE_DIR is set; that markup is only a DOM dump until it is painted, so this drops the app's
 * own compiled Tailwind beside the dumps as `app.css` (the stylesheet each dump already links) and screenshots
 * every surface at the width a person reads it:
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-pass2-signin-1026.test.tsx \
 *     tests/unit/evidence-pass2-chat-1026.test.tsx tests/unit/evidence-pass2-bookings-1026.test.tsx
 *   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/pass2-1026.config.ts
 */
import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DIR = process.env.EVIDENCE_DIR ?? path.resolve("tests/browser/pass2-1026/.shots");
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1680, height: 900 };

/** dumped page → the width it is painted at (a phone door is read on a phone). */
const SURFACES: [string, "desktop" | "phone" | "wide"][] = [
  ["20-signin-phone-first", "phone"],
  ["21-signin-code-six-boxes", "phone"],
  ["22-signin-email-opened", "phone"],
  ["23-signin-phone-off", "phone"],
  ["30-stay-chat-resident", "desktop"],
  ["31-stay-chat-manager", "desktop"],
  ["32-tour-host-team-thread", "desktop"],
  ["40-bookings-timeline-channels", "wide"],
  ["41-channel-link-modal", "desktop"],
  ["42-channel-link-paste-many", "desktop"],
  ["43-integrations-bookings-rows", "desktop"],
  ["44-integrations-posting-spareroom", "desktop"],
  ["45-booking-channel-link-field", "desktop"],
];

async function tailwindCss(): Promise<string> {
  const cssPath = path.resolve("src/app/globals.css");
  return (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
}

test("paints every dumped pass-2 surface", async ({ page }) => {
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
    // The stylesheet is what makes a dump a picture: refuse an unstyled shot.
    const styled = await page.evaluate(() => document.styleSheets.length > 0 && getComputedStyle(document.body).backgroundColor !== "");
    expect(styled, `${name} painted without its stylesheet`).toBe(true);
    const out = `${name}.png`;
    await page.screenshot({ path: path.join(DIR, out), fullPage: true });
    painted.push(out);

    // The month track is wider than any screen: the timeline is read by scrolling it, so the rest of
    // the month (the open-ended block and its "no end" tag) gets a shot of its own.
    if (name.startsWith("40-")) {
      const scrolled = await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>("div")) {
          if (el.scrollWidth > el.clientWidth + 40) {
            el.scrollLeft = el.scrollWidth;
            return true;
          }
        }
        return false;
      });
      expect(scrolled, "the timeline track did not scroll").toBe(true);
      const later = `${name}-scrolled.png`;
      await page.screenshot({ path: path.join(DIR, later), fullPage: true });
      painted.push(later);
    }
  }
  console.log(`painted ${painted.length} shots into ${DIR}:\n  ${painted.join("\n  ")}`);
});
