import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  countPropertiesWithOwnPricing,
  propertyHasOwnRoomPricing,
} from "@/lib/property-pricing-override-count";

describe("propertyHasOwnRoomPricing", () => {
  it("counts room with priceSource own", () => {
    const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
    const roomId = sub.rooms[0]!.id;
    sub.roomPricingMeta = { [roomId]: { priceSource: "own" } };
    expect(propertyHasOwnRoomPricing(sub)).toBe(true);
    expect(countPropertiesWithOwnPricing([sub, createDefaultListingSubmission()])).toBe(1);
  });
});
