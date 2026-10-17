import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("Edit property wizard sweep (P6)", () => {
  const editor = read("src/components/portal/listing-wizard-v2/listing-editor.tsx");
  const steps = read("src/components/portal/listing-wizard-v2/listing-detail-steps.tsx");

  it("title only: no address subtitle under the wizard title", () => {
    expect(editor).not.toMatch(/subtitle=\{\[submission\.address/);
  });

  it("property type tiles use one-word labels in a two-column grid so none wraps", () => {
    const block = editor.slice(editor.indexOf("const PROPERTY_KIND_TILES"), editor.indexOf("/** `listingTotalBathroomsId`"));
    for (const label of ["House", "Townhouse", "Condo", "Small building", "Apartment", "Other"]) {
      expect(block).toContain(`label: "${label}"`);
    }
    expect(block).not.toMatch(/label: "(A|An) /);
    expect(editor).toContain('<div className="grid grid-cols-2 gap-2.5">\n            {PROPERTY_KIND_TILES');
  });

  it("pricing step prints each rent once (right-hand figure), not again in the facts", () => {
    expect(steps).not.toMatch(/Long-term · \$\{/);
    expect(steps).toContain('stays.long_term && "Long-term",');
  });
});

describe("Pop-up panes (P5, P7)", () => {
  it("flyer editor is two columns: no auto rail, the flyer fills the preview column, form does not repeat it", () => {
    const panel = read("src/components/portal/pro-property-promotion-panel.tsx");
    const block = panel.slice(panel.indexOf('title="Edit flyer"'), panel.indexOf("<PromotionAssetViewModal"));
    expect(block).toContain("contextPanel={null}");
    expect(block).toContain("<PromotionFlyerPreview");
    expect(block).toContain("hidePreview");
  });

  it("house details editor is one column and Add room does not write before Save", () => {
    const modal = read("src/components/portal/property-house-details-editor-modal.tsx");
    expect(modal).toContain("contextPanel={null}");
    expect(modal).toContain("preview={null}");
    const list = read("src/components/portal/property-house-details-list-panel.tsx");
    const addRoom = list.slice(list.indexOf("const addRoom"), list.indexOf("const addBathroom"));
    expect(addRoom).not.toContain("persistSub");
    expect(addRoom).toContain("submissionWithNewRoom");
  });
});
