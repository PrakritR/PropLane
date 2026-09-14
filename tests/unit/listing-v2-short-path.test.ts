/**
 * "For listing only have title, pictures, price and description."
 * "There is too much on the listing."
 *
 * The editor's Continue button walks a SHORT path — Basics (title, photos,
 * description) → Pricing → Review — and treats Rooms, Bathrooms and Shared spaces
 * as optional detail reachable from the rail and from Add details on Basics.
 * A home let by the room keeps Rooms on the path, because there the rooms ARE the
 * product; and a detail step the manager already filled in stays on the path.
 */
import { describe, expect, it } from "vitest";
import { LISTING_V2_STEPS, listingV2PathStepIds } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

describe("the short path through the listing editor", () => {
  it("a whole-place listing is Basics → Pricing → Review", () => {
    const sub = { ...createDefaultListingSubmission(), listingPlaceCategoryId: "entire_home", rooms: [], bathrooms: [], sharedSpaces: [] };
    expect(listingV2PathStepIds(sub)).toEqual(["basics", "pricing", "review"]);
  });

  it("a by-the-room listing keeps Rooms on the path — the rooms are the product", () => {
    const sub = { ...createDefaultListingSubmission(), listingPlaceCategoryId: "shared_home", rooms: [], bathrooms: [], sharedSpaces: [] };
    expect(listingV2PathStepIds(sub)).toEqual(["basics", "rooms", "pricing", "review"]);
  });

  it("detail the manager already entered stays on the path", () => {
    const base = createDefaultListingSubmission();
    const sub = {
      ...base,
      listingPlaceCategoryId: "entire_home",
      rooms: [],
      bathrooms: [{ ...(base.bathrooms?.[0] ?? {}), id: "b1", name: "Bath 1" }],
      sharedSpaces: [{ ...(base.sharedSpaces?.[0] ?? {}), id: "s1", name: "Kitchen" }],
    } as typeof base;
    expect(listingV2PathStepIds(sub)).toEqual(["basics", "bathrooms", "spaces", "pricing", "review"]);
  });

  it("the path is always a subsequence of the full step list", () => {
    const sub = createDefaultListingSubmission();
    const all = LISTING_V2_STEPS.map((s) => s.id);
    const path = listingV2PathStepIds(sub);
    let cursor = 0;
    for (const id of path) {
      const at = all.indexOf(id, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + 1;
    }
    expect(path[0]).toBe("basics");
    expect(path[path.length - 1]).toBe("review");
  });
});
