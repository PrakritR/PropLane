/**
 * AXI-161 — "update calendar ui there is some overlap with am".
 *
 * `CALENDAR_TIME_CELL` is `whitespace-nowrap`, so a time label that does not fit
 * its column does not wrap — it OVERFLOWS into the first day column. At 44px,
 * minus the cell's own padding, roughly 28px of text fitted; "11:30 am" at 11px
 * is about 47px. Every half-hour past 10 o'clock collided with the grid.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatAvailabilitySlotLabel } from "@/lib/demo-admin-scheduling";

const src = readFileSync("src/components/portal/portal-calendar-panels.tsx", "utf8");

/** Rough advance width of the label at 11px semibold tabular-nums. */
function approxLabelPx(label: string): number {
  return label.length * 6;
}

describe("the calendar time gutter fits its widest label", () => {
  it("no longer sizes the week grid at 44px", () => {
    expect(src).not.toContain("grid-cols-[44px_repeat(7,minmax(0,1fr))]");
    expect(src).toContain("grid-cols-[64px_repeat(7,minmax(0,1fr))]");
  });

  it("widens the single-day grid the same way", () => {
    expect(src).not.toContain("grid-cols-[3.25rem_1fr]");
    expect(src).toContain("grid-cols-[4rem_1fr]");
  });

  it("the label still cannot wrap, so the column has to be the thing that fits", () => {
    // Removing nowrap would "fix" the overlap by making every row two lines tall.
    expect(src).toContain("whitespace-nowrap text-[10px] font-semibold tabular-nums");
  });

  it("64px clears the widest half-hour label plus its padding", () => {
    const widest = Array.from({ length: 48 }, (_, i) => formatAvailabilitySlotLabel(i)).reduce(
      (a, b) => (approxLabelPx(b) > approxLabelPx(a) ? b : a),
    );
    // sm:px-2 → 8px each side.
    expect(approxLabelPx(widest) + 16).toBeLessThanOrEqual(64);
    // …and the old width did not, which is the bug this pins.
    expect(approxLabelPx(widest) + 16).toBeGreaterThan(44);
  });
});
