import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C150: vendor Services' job detail (Invoice tab, `renderRowDetail` in
 * `vendor-work-orders-panel.tsx`) showed the quote pricing mode ("Upfront" /
 * "After consultation") as a rounded pill next to the "Quote" label. Status is
 * a value, never a pill (record-page.md §3) — the label now carries the mode
 * as plain text. This is scoped to that one chip: the shared cross-file
 * `<Badge`/`PortalRowStatusChip` sweep in `portal-list-rows-no-pills.test.ts`
 * already covers this file for the general pattern, and other files
 * legitimately use `portal-badge-pending` rounded chips elsewhere (e.g.
 * screening status), so this guard does not generalize across files.
 */
describe("vendor Services quote mode renders as plain text, not a pill", () => {
  it("vendor-work-orders-panel.tsx never wraps the quote mode in a rounded-full portal-badge-pending chip", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/vendor-work-orders-panel.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/rounded-full[^"]*portal-badge-pending/);
    // The mode still renders, just as text beside the "Quote" label.
    expect(source).toMatch(/After consultation/);
    expect(source).toMatch(/quoteMode === "after_consultation" \? "After consultation" : "Upfront"/);
  });
});
