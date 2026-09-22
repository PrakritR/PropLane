import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CALENDAR_PANELS = readFileSync(
  join(process.cwd(), "src/components/portal/portal-calendar-panels.tsx"),
  "utf8",
);
const MODAL_STYLES = readFileSync(join(process.cwd(), "src/components/ui/modal-styles.ts"), "utf8");
const MODAL = readFileSync(join(process.cwd(), "src/components/ui/modal.tsx"), "utf8");
const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * The calendar detail modal used to hand-roll its own `fixed inset-0` overlay
 * and a literal `.modal-panel` div with its own height cap and
 * `overflow-y-auto`, so the PAGE could never scroll it and a tall tour inquiry
 * (name/email/phone/property/room/notes + the action row) still stayed
 * reachable on a short phone.
 *
 * "Put calendar events and the booking day list on the shared popup"
 * (5a3d3905) moved this dialog onto `PortalDialog` (`src/components/portal/
 * portal-dialog.tsx`), which per AGENTS.md's UI rules is now the ONE owner of
 * that contract for every dialog in the portal — a fixed-overlay stack, a
 * `.modal-panel` that caps its own height against the viewport, and a
 * scrolling body inside it (`src/components/ui/modal.tsx` /
 * `modal-styles.ts`). The invariant did not disappear, it moved to the shared
 * component; these assertions were updated to check it there instead of in
 * this file's own source text.
 */
describe("calendar detail modal keeps its action row reachable", () => {
  it("renders its detail dialog through the shared PortalDialog, not a hand-rolled overlay", () => {
    expect(CALENDAR_PANELS).toMatch(/import\s*\{[^}]*\bPortalDialog\b[^}]*\}\s*from\s*"@\/components\/portal\/portal-dialog"/);
    expect(CALENDAR_PANELS).toMatch(/<PortalDialog[\s\S]*?dataAttr="calendar-event-detail-modal"/);
  });

  it("caps the panel height and scrolls inside it", () => {
    // The invariant is that the shared panel caps its own height against the
    // viewport, not any particular pixel ceiling — that number is a design
    // choice PortalDialog's own callers do not each repin.
    expect(MODAL_STYLES).toMatch(/modal-panel[^"]*max-h-\[min\(/);
    // The body band scrolls internally instead of depending on the page.
    expect(MODAL).toContain("overflow-y-auto");
  });

  it("still sits in a fixed overlay, which is why the cap is load-bearing", () => {
    expect(MODAL).toMatch(/fixed inset-0 z-\[\d+\]/);
  });

  it("cannot borrow a height cap from .modal-panel's own CSS rule", () => {
    const block = GLOBALS_CSS.slice(GLOBALS_CSS.indexOf(".modal-panel {"));
    const body = block.slice(0, block.indexOf("}"));
    expect(body).not.toContain("max-height");
    expect(body).not.toContain("overflow");
  });
});
