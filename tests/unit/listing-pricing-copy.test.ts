import { describe, expect, it } from "vitest";
import { copyListingPricingBetweenSubmissions } from "@/lib/listing-pricing-copy";
import {
  createDefaultListingSubmission,
  emptyRoom,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

describe("copyListingPricingBetweenSubmissions", () => {
  it("copies listing Other fees and per-room rent without changing room ids or move-in copy", () => {
    const source: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationFee: "50",
      holdingDeposit: "100",
      monthToMonthSurcharge: "25",
      customLeaseSurcharge: "100",
      customFees: [
        {
          id: "fee-mtm",
          label: "Month-to-month surcharge",
          amount: "25",
          frequency: "monthly",
          presetId: "mtm_surcharge",
        },
      ],
      rooms: [
        { ...emptyRoom(0), id: "src-r1", name: "Room 1", monthlyRent: 825, shortTermRent: "50", utilitiesEstimate: "$175/month" },
        { ...emptyRoom(1), id: "src-r2", name: "Room 2", monthlyRent: 1025, shortTermRent: "65", utilitiesEstimate: "$175/month" },
      ],
    };
    const target: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationFee: "0",
      rooms: [
        {
          ...emptyRoom(0),
          id: "tgt-r1",
          name: "Room 1",
          monthlyRent: 400,
          moveInInstructions: "Keep this move-in text",
        },
        {
          ...emptyRoom(1),
          id: "tgt-r2",
          name: "Room 2",
          monthlyRent: 500,
          moveInInstructions: "Also keep",
        },
      ],
    };

    const { submission, summary } = copyListingPricingBetweenSubmissions(source, target);
    expect(summary.roomsUpdated).toBe(2);
    expect(submission.applicationFee).toBe("50");
    expect(submission.holdingDeposit).toBe("$100");
    expect(submission.monthToMonthSurcharge).toBe("25");
    expect(submission.customLeaseSurcharge).toBe("100");
    expect(submission.rooms[0]!.id).toBe("tgt-r1");
    expect(submission.rooms[0]!.monthlyRent).toBe(825);
    expect(submission.rooms[0]!.shortTermRent).toBe("50");
    expect(submission.rooms[0]!.moveInInstructions).toBe("Keep this move-in text");
    expect(submission.rooms[1]!.monthlyRent).toBe(1025);
  });
});
