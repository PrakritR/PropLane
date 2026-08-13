import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CALENDAR_PANELS = readFileSync(
  join(process.cwd(), "src/components/portal/portal-calendar-panels.tsx"),
  "utf8",
);
const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * The calendar detail modal sits in a `fixed inset-0` overlay, so the PAGE can
 * never scroll it, and `.modal-panel` sets no height of its own. The panel's own
 * cap plus `overflow-y-auto` is therefore the ONLY thing that keeps a tall tour
 * inquiry (name/email/phone/property/room/notes + the action row) reachable on a
 * short phone. Dropping them stranded Approve and Delete off-screen.
 */
describe("calendar detail modal keeps its action row reachable", () => {
  it("caps the panel height and scrolls inside it", () => {
    const panel = CALENDAR_PANELS.split("\n").find(
      (line) => line.includes("modal-panel") && line.includes("z-[81]"),
    );
    expect(panel).toBeTruthy();
    // The invariant is that the panel caps its own height against the viewport
    // (AGENTS.md: "a hand-rolled .modal-panel must cap its own height"), not any
    // particular pixel ceiling — that number is a design choice and has already
    // moved once (520 -> 600). Match the shape so a retune stays green while
    // REMOVING the cap still fails.
    expect(panel).toMatch(/max-h-\[min\(\d+px,calc\(100svh-2rem\)\)\]/);
    expect(panel).toContain("overflow-y-auto");
  });

  it("still sits in a fixed overlay, which is why the cap is load-bearing", () => {
    expect(CALENDAR_PANELS).toContain('className="fixed inset-0 z-[80] flex items-center justify-center p-4"');
  });

  it("cannot borrow a height cap from .modal-panel", () => {
    const block = GLOBALS_CSS.slice(GLOBALS_CSS.indexOf(".modal-panel {"));
    const body = block.slice(0, block.indexOf("}"));
    expect(body).not.toContain("max-height");
    expect(body).not.toContain("overflow");
  });
});
