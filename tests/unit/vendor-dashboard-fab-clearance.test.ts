// N058 — the vendor Dashboard's "Your jobs" section header (Add / Manage
// services) can sit within ~100px of the fixed assistant FAB on a short
// page with nothing to attend to and nothing upcoming: that section is the
// last content on the page, so there is no guarantee of scroll distance
// between it and the floating FAB. Raise the FAB clear of that corner
// whenever the section is on screen, rather than only reserving scroll room
// (which does not help when the page never scrolls).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VENDOR_DASHBOARD_SOURCE = readFileSync(
  join(process.cwd(), "src/components/portal/vendor-dashboard.tsx"),
  "utf8",
);
const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

describe("vendor dashboard FAB clearance (N058)", () => {
  it("tags the Your-jobs section with a stable selector", () => {
    expect(VENDOR_DASHBOARD_SOURCE).toContain('data-attr="dashboard-your-jobs"');
  });

  it("raises the assistant FAB clear of that section's own header controls", () => {
    expect(GLOBALS_CSS).toMatch(
      /html:has\(\[data-attr="dashboard-your-jobs"\]\)\s*\.axis-assistant-fab\s*\{[^}]*bottom:/,
    );
  });
});
