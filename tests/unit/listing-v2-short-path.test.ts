/** The Next path is always a subsequence of the full step list, from Basics to Review (see listing-next-every-step.test.ts). */
import { describe, expect, it } from "vitest";
import { LISTING_V2_STEPS, listingV2PathStepIds } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

describe("the path through the listing editor", () => {
  it("is ordered, starts at Basics and ends at Review", () => {
    const all = LISTING_V2_STEPS.map((s) => s.id);
    const path = listingV2PathStepIds(createDefaultListingSubmission());
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
