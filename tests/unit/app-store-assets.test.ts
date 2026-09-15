// The committed App Store product page (app-store/) must be exactly what Apple
// accepts: every screenshot at its display's pixel size, at most ten per
// display, and copy within the field limits. A production push uploads these
// files as they are, so a wrong one here is a red release run later.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_STORE_DIR,
  COPY_LIMITS,
  MAX_SCREENSHOTS_PER_SET,
  pngSize,
  readLocalScreenshots,
  SCREENSHOT_SETS,
  validateCopy,
} from "../../scripts/ios-app-store-release.mjs";

describe("app-store/ product page", () => {
  it("carries copy within Apple's limits", () => {
    const copy = JSON.parse(readFileSync(resolve(APP_STORE_DIR, "copy.json"), "utf8"));
    expect(() => validateCopy(copy)).not.toThrow();
    for (const [field, limit] of Object.entries(COPY_LIMITS)) {
      expect(copy[field].length, field).toBeLessThanOrEqual(limit);
    }
  });

  for (const set of SCREENSHOT_SETS) {
    it(`${set.folder}: every PNG is ${set.width}×${set.height}, at most ${MAX_SCREENSHOTS_PER_SET}, in store order`, () => {
      const folder = resolve(APP_STORE_DIR, "screenshots", set.folder);
      const files = readdirSync(folder).filter((name) => name.endsWith(".png")).sort();
      expect(files.length).toBeGreaterThan(0);
      expect(files.length).toBeLessThanOrEqual(MAX_SCREENSHOTS_PER_SET);
      // 01-…, 02-…: the prefix is the store order and the install sheet is the first three.
      files.forEach((name, index) => expect(name.startsWith(`${String(index + 1).padStart(2, "0")}-`), name).toBe(true));
      for (const name of files) {
        expect(pngSize(readFileSync(resolve(folder, name))), name).toEqual({ width: set.width, height: set.height });
      }
      // The same check the release script runs before it touches App Store Connect.
      expect(() => readLocalScreenshots(set)).not.toThrow();
    });
  }
});
