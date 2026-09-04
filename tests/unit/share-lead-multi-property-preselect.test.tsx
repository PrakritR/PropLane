/**
 * @vitest-environment jsdom
 *
 * AXI-140 — "when i selected multiple properties i should be able to share link."
 *
 * The share modal's `listing` and `apply` kinds were already multi-select
 * (several listings become a filtered `/rent/browse?ids=…` link). The Properties
 * bulk bar just never used it: Share was gated on `canBulkEdit`, i.e. exactly
 * one row selected, so the multi-send was unreachable from a multi-selection.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  path.join(process.cwd(), "src/components/portal/manager-house-properties-panel.tsx"),
  "utf8",
);
const modal = readFileSync(
  path.join(process.cwd(), "src/components/portal/share-lead-link-modal.tsx"),
  "utf8",
);

describe("bulk share from the Properties list", () => {
  it("no longer gates Share on a single selection", () => {
    const gate = panel.split("const canBulkShareProperties =")[1]?.split(";")[0] ?? "";
    expect(gate).toContain("selectedPropertyEntries.length > 0");
    // Edit stays single-selection; Share must not borrow that gate again.
    expect(gate).not.toContain("canBulkEdit");
  });

  it("sends every selected row, not just the first", () => {
    const handler = panel.split('data-attr="properties-bulk-share"')[1]?.slice(0, 900) ?? "";
    expect(handler).toContain("selectedPropertyEntries");
    expect(handler).toContain(".map(");
    expect(handler).not.toContain("selectedPropertyEntries[0]");
  });

  it("keeps Edit gated on exactly one selection", () => {
    expect(panel).toContain("const canBulkEdit = selectedPropertyEntries.length === 1;");
  });

  it("seeds the modal with the whole selection and drops ids it does not know", () => {
    const effect = modal.split("const knownIds = new Set(")[1]?.slice(0, 700) ?? "";
    expect(effect, "multi preselect should be filtered against known properties").toContain(
      "filter((id) => knownIds.has(id))",
    );
    // The singular prop must keep working for the row-level "Send to prospect".
    expect(effect).toContain("preselectedPropertyId");
  });
});
