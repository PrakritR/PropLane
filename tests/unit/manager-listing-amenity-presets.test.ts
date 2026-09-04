/**
 * AXI-135 — "add more ammenities … to create listing page".
 *
 * These labels are stored VERBATIM as lines in `amenitiesText` /
 * `roomAmenitiesText` / the shared-space and bathroom fields, and the form
 * toggles match on the label. So the list is append-only in practice: renaming
 * an existing entry silently un-ticks it on every saved listing.
 */
import { describe, expect, it } from "vitest";
import {
  BATHROOM_EXTRA_AMENITY_PRESETS,
  DISALLOWED_BATHROOM_AMENITY_LABELS,
  HOUSE_WIDE_AMENITY_PRESETS,
  ROOM_AMENITY_PRESETS,
  SHARED_SPACE_AMENITY_PRESETS,
  SHARED_SPACE_KIND_OPTIONS,
  sharedSpaceAmenityPresetsForKind,
} from "@/data/manager-listing-presets";

const LISTS = {
  house: HOUSE_WIDE_AMENITY_PRESETS,
  shared: SHARED_SPACE_AMENITY_PRESETS,
  room: ROOM_AMENITY_PRESETS,
  bathroom: BATHROOM_EXTRA_AMENITY_PRESETS,
} as const;

describe("listing amenity presets", () => {
  it.each(Object.entries(LISTS))("%s presets have unique ids and labels", (_name, presets) => {
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    expect(new Set(presets.map((p) => p.label)).size).toBe(presets.length);
  });

  it.each(Object.entries(LISTS))("%s presets have non-empty labels", (_name, presets) => {
    for (const preset of presets) {
      expect(preset.id.trim()).not.toBe("");
      expect(preset.label.trim()).not.toBe("");
    }
  });

  it("keeps the bathroom fixtures out of the bathroom amenity list", () => {
    // Shower / Toilet / Bathtub are the row's own checkboxes; duplicating them
    // here would let a bathroom claim a fixture it does not have.
    for (const preset of BATHROOM_EXTRA_AMENITY_PRESETS) {
      expect(DISALLOWED_BATHROOM_AMENITY_LABELS.has(preset.label)).toBe(false);
    }
  });

  it("assigns every shared-space amenity to at least one real space type", () => {
    // A preset missing from every bucket only ever shows on a space typed
    // "Other", which is how a new amenity silently goes missing.
    const realKinds = SHARED_SPACE_KIND_OPTIONS.map((k) => k.id).filter((id) => id !== "other");
    const reachable = new Set(
      realKinds.flatMap((kind) => sharedSpaceAmenityPresetsForKind(kind).map((p) => p.id)),
    );
    const orphans = SHARED_SPACE_AMENITY_PRESETS.filter((p) => !reachable.has(p.id)).map((p) => p.id);
    expect(orphans, `unreachable outside "Other": ${orphans.join(", ")}`).toEqual([]);
  });

  it('still returns every amenity for the "Other" space type', () => {
    expect(sharedSpaceAmenityPresetsForKind("other").length).toBe(SHARED_SPACE_AMENITY_PRESETS.length);
  });
});
