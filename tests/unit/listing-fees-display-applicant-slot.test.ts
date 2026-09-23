import { describe, expect, it } from "vitest";
import {
  applicantFirstChoiceRentLabel,
  applicantListingQuote,
  applicantPaymentAtSigningPriceLabel,
} from "@/lib/rental-application/listing-fees-display";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

function sharedRoomListing(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const normalized = normalizeManagerListingSubmissionV1({
    ...base,
    address: "5259 Brooklyn Ave NE",
    city: "Portland",
    state: "OR",
    zip: "97201",
    securityDeposit: "250",
    applicationFee: "50",
    rooms: [
      {
        ...base.rooms[0]!,
        id: "room-9",
        name: "Room 9",
        monthlyRent: 1200,
        securityDeposit: "250",
        occupancyCapacity: 2,
        residentPricing: "per_resident",
        residentPrices: [
          { monthlyRent: 1050, securityDeposit: "250" },
          { monthlyRent: 1200, securityDeposit: "250" },
        ],
      },
    ],
  } as ManagerListingSubmissionV1);
  return {
    ...normalized,
    paymentAtSigningByLeaseType: {
      [LONG_TERM_LEASE_TERM]: ["room_rent:room-9", "security_deposit"],
    },
  };
}

describe("applicant listing quote for a shared room", () => {
  it("hides until a first-choice room is set", () => {
    expect(applicantListingQuote(sharedRoomListing(), { roomChoice1: "" })).toBeNull();
  });

  it("quotes Resident 1 and Resident 2 as different signing totals", () => {
    const sub = sharedRoomListing();
    const first = applicantListingQuote(sub, {
      roomChoice1: "listing-a::room-9::r1",
      leaseTerm: LONG_TERM_LEASE_TERM,
    });
    const second = applicantListingQuote(sub, {
      roomChoice1: "listing-a::room-9::r2",
      leaseTerm: LONG_TERM_LEASE_TERM,
    });
    expect(first?.monthlyRent).toBe(1050);
    expect(second?.monthlyRent).toBe(1200);
    expect(first?.signingLines.find((line) => /rent/i.test(line.label))?.amount).toBe(1050);
    expect(second?.signingLines.find((line) => /rent/i.test(line.label))?.amount).toBe(1200);
    expect(first?.securityDeposit).toBe(250);
    expect(applicantFirstChoiceRentLabel(sub, "listing-a::room-9::r1")).toBe("$1050.00/mo");
    expect(applicantFirstChoiceRentLabel(sub, "listing-a::room-9::r2")).toBe("$1200.00/mo");
    expect(
      applicantPaymentAtSigningPriceLabel(sub, {
        roomChoice1: "listing-a::room-9::r1",
        leaseTerm: LONG_TERM_LEASE_TERM,
      }),
    ).toBe(`$${first!.signingTotal.toFixed(2)}`);
  });
});
