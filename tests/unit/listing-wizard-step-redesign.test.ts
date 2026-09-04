/**
 * PRP-137 / PRP-138 / PRP-139 — the Rooms, Bathrooms and Shared spaces steps of
 * the create-listing wizard, redesigned to the options the captain picked
 * (137→A rows, 138→B type tiles, 139→A tiles-to-add).
 *
 * The common complaint was that each step is a stack of collapsible cards whose
 * collapsed state shows a bare name, so the facts a manager compares on — a
 * room's rent, a bathroom's type — were only visible one at a time.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const form = readFileSync("src/components/portal/pro-add-listing-form.tsx", "utf8");

describe("one row component across all three steps", () => {
  it("the wizard row can carry a right-aligned headline value", () => {
    expect(form).toContain("function ListingWizardRowMeta");
    expect(form).toContain("meta?: ReactNode;");
    expect(form).toContain("{meta ? <div");
  });
});

describe("PRP-137 rooms", () => {
  it("shows rent on the row instead of only inside it", () => {
    expect(form).toContain('<ListingWizardRowMeta value={`$${room.monthlyRent} / mo`} />');
  });

  it("says so plainly when the rent is still missing", () => {
    expect(form).toContain('<ListingWizardRowMeta value="Rent not set" muted />');
  });

  it("puts size on the row, and stops printing the whole furniture list there", () => {
    // The old subtitle interpolated `room.furnishing`, which pushed the rest of
    // the line off the end once a few items were ticked.
    expect(form).toContain('room.sizeSqft != null && room.sizeSqft > 0 ? `${room.sizeSqft} sq ft` : null');
    expect(form).toContain('room.furnishing.trim() ? "Furnished" : null');
  });
});

describe("PRP-138 bathrooms", () => {
  it("offers the three answers as one tap each", () => {
    expect(form).toContain("data-attr={`listing-add-bathroom-${option.id}`}");
    expect(form).toContain("const addBathroomOfType = (type: \"full\" | \"half\" | \"ensuite\")");
    for (const label of ["Full bath", "Half bath", "En-suite"]) {
      expect(form).toContain(`label: "${label}"`);
    }
  });

  it("presets the fixtures rather than storing a type", () => {
    // A manager who unticks the shower has a half bath, whichever tile made it —
    // so the label is derived from the fixtures, never a second stored field.
    expect(form).toContain("const bathTypeLabel = !b.toilet");
    expect(form).not.toContain("bathroomType:");
  });

  it("shows that type on the row", () => {
    expect(form).toContain("meta={<ListingWizardRowMeta value={bathTypeLabel} />}");
  });
});

describe("PRP-139 shared spaces", () => {
  it("drops the blue Quick add banner", () => {
    // Only the comment explaining its removal may still say the words.
    expect(form).not.toContain("portal-banner-info");
    expect(form).not.toContain('>Quick add<');
    // The old blank-space button lived inside that banner; its replacement is
    // the dashed ADD row asserted below.
    expect(form).not.toContain('>+ Blank shared space<');
  });

  it("has ONE empty state, not two", () => {
    // The banner and a dashed "No shared spaces added yet… use Quick add above"
    // box used to appear together.
    expect(form).not.toContain("No shared spaces added yet.");
  });

  it("makes the common spaces recognisable tiles", () => {
    expect(form).toContain("SHARED_SPACE_KIND_ICONS");
    expect(form).toContain("listing-add-shared-${template.kind}");
  });

  it("puts ADD below the list, dashed and uppercase, like every other portal list", () => {
    expect(form).toContain('data-attr="listing-add-shared-blank"');
    expect(form).toContain("+ Add shared space");
    expect(form).toContain('aria-label="Add a shared space"');
  });

  it("says the step is optional once, up front", () => {
    expect(form).toContain("Add the common areas you want on\n                the listing, or skip this step.");
  });
});
