/**
 * AXI-141 — "when i click edit specifically it takes a second to go into page
 * have a loading screen".
 *
 * Edit resolves its listing from the local property mirror, which can still be
 * hydrating on the first click. Until it resolved, `listingFormProps` was null
 * and the render was `open && props ? <wizard/> : null` — so the click produced
 * NOTHING on screen for a beat.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "src/components/portal/manager-house-properties-panel.tsx"),
  "utf8",
);

describe("opening the listing editor acknowledges the click", () => {
  it("renders a placeholder while the listing is still resolving", () => {
    expect(source).toContain("listingEditorOpen && !listingFormProps");
    expect(source).toContain("ListingEditorLoadingModal");
  });

  it("covers the draft editor too, which resolves the same way", () => {
    expect(source).toContain("draftEditorOpen && !draftFormProps");
  });

  it("still renders the real wizard once the listing resolves", () => {
    expect(source).toContain("listingEditorOpen && listingFormProps");
    expect(source).toContain("draftEditorOpen && draftFormProps");
  });

  it("announces itself to assistive tech rather than being a bare spinner", () => {
    const modal = source.split("function ListingEditorLoadingModal")[1]?.slice(0, 1200) ?? "";
    expect(modal).toContain('role="status"');
    expect(modal).toContain('aria-live="polite"');
  });

  it("stays closable, so a hydration that never lands cannot trap the manager", () => {
    const modal = source.split("function ListingEditorLoadingModal")[1]?.slice(0, 1200) ?? "";
    expect(modal).toContain("onClose");
  });
});
