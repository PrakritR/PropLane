/**
 * Captain's choice: Next visits EVERY step. An empty optional step (Rooms, Bathrooms, Shared spaces)
 * shows its own empty state with its Add action instead of being skipped silently.
 */
import { describe, expect, it } from "vitest";
import { LISTING_V2_STEPS, listingV2PathStepIds } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

describe("the Next path through the listing editor", () => {
  const all = LISTING_V2_STEPS.map((s) => s.id);

  it("a whole-place listing with nothing entered still visits every step", () => {
    const sub = { ...createDefaultListingSubmission(), listingPlaceCategoryId: "entire_home", rooms: [], bathrooms: [], sharedSpaces: [] };
    expect(listingV2PathStepIds(sub)).toEqual(all);
  });

  it("a by-the-room listing visits every step", () => {
    const sub = { ...createDefaultListingSubmission(), listingPlaceCategoryId: "shared_home", rooms: [], bathrooms: [], sharedSpaces: [] };
    expect(listingV2PathStepIds(sub)).toEqual(all);
  });

  it("empty Rooms, Bathrooms and Shared spaces are on the path", () => {
    const sub = { ...createDefaultListingSubmission(), listingPlaceCategoryId: "entire_home", rooms: [], bathrooms: [], sharedSpaces: [] };
    const path = listingV2PathStepIds(sub);
    for (const id of ["rooms", "bathrooms", "spaces"] as const) expect(path).toContain(id);
  });
});
