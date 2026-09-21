import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Services and Applications' record-page header actions are "real or
 * absent" — an unwired header icon is dropped from the rail rather than
 * shown as a dead "Coming soon" click (unlike the general record-page
 * carve-out in docs/agents/record-page.md § Known gap, which several other
 * kinds still use intentionally). This guards the specific files this pass
 * converted; it is not a codebase-wide ban on "Coming soon".
 */
const NO_COMING_SOON_FILES = [
  "src/components/portal/pro-work-orders-panel.tsx",
  "src/components/portal/pro-all-services-panel.tsx",
  "src/components/portal/pro-applications.tsx",
];

describe("services and applications record pages never show a dead 'Coming soon'", () => {
  for (const path of NO_COMING_SOON_FILES) {
    it(`${path} never calls showToast("Coming soon")`, () => {
      const src = readFileSync(`${process.cwd()}/${path}`, "utf8");
      // A reference IN A COMMENT explaining the "real or absent" rule (which
      // itself quotes the phrase) is fine — only the live call that would
      // actually surface it to a manager is checked.
      expect(src).not.toMatch(/showToast\(\s*["']coming soon["']/i);
    });
  }
});
