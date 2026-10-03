import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  applyWorkspaceDefaultsOnPublish,
  propertyPricingPublishBlocker,
} from "@/lib/property-pricing-publish";
import { SEATTLE_DEMO_WORKSPACE_PRICING_DEFAULTS } from "@/lib/workspace-pricing-defaults";

describe("propertyPricingPublishBlocker", () => {
  it("refuses when a named room has no price and no default", () => {
    const room = { ...emptyRoom(0), name: "Unit A", monthlyRent: 0 };
    const sub = normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), rooms: [room] });
    expect(propertyPricingPublishBlocker(sub, {})).toMatch(/Unit A needs a price/);
  });

  it("fills from workspace defaults on publish", () => {
    const room = { ...emptyRoom(0), name: "Private", monthlyRent: 0, occupancyCapacity: 1 };
    const sub = normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), rooms: [room] });
    const { submission, filledRooms } = applyWorkspaceDefaultsOnPublish(sub, SEATTLE_DEMO_WORKSPACE_PRICING_DEFAULTS);
    expect(filledRooms).toContain("Private");
    expect(submission.rooms[0]?.monthlyRent).toBe(950);
    expect(submission.roomPricingMeta?.[submission.rooms[0]!.id]?.priceSource).toBe("default");
  });
});
