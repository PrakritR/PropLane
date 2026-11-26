/**
 * @vitest-environment jsdom
 *
 * A whole-unit listing prorates its partial months by the WHOLE-HOUSE setting the manager typed in Pricing
 * ("Set per day", $X a day) — it has no room row for an applicant to read it from. The applicant quote, the
 * lease document's billing snapshot and the ledger take that decision from one resolver, so the move-in receipt
 * states the figure that is actually charged.
 *
 * Oracles: the figures the manager typed ($120 a day over 17 billable days = $2,040; a $90/month fee at its own
 * typed $4 a day = $68) and `resolveLeaseProrationInputForApplicant`, the resolver the lease document and the
 * billing snapshot read. Plausible wrong behaviour this rejects: the quote falling back to the calendar fraction
 * ($3,600 × 17/31 = $1,974.19 of rent, $49.35 of fee) because no room row carried the setting.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applicantListingQuote } from "@/lib/rental-application/listing-fees-display";
import { computeProratedFirstMonthTotals, computeProratedLastMonthTotals } from "@/lib/lease-first-period-proration";
import { resolveLeaseProrationInputForApplicant } from "@/lib/lease-proration-settings";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import {
  applyEntireHomeListingPricing,
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-whole-house";
const PROPERTY_ID = "prop-whole-house";
const LEASE_START = "2027-01-15";
const LEASE_END = "2027-12-14";
const DAILY_RENT_RATE = 120;
const MONTHLY_RENT = 3600;

function wholeHouse(fees: Parameters<typeof applyListingFeesToSubmission>[1] = []): ManagerListingSubmissionV1 {
  let sub = createDefaultListingSubmission();
  sub.rooms = [{ ...sub.rooms[0]!, id: "room-1", name: "Whole house", monthlyRent: MONTHLY_RENT, utilitiesEstimate: "" }];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.allowedLeaseTerms = ["Long-term"];
  sub = applyEntireHomeListingPricing(sub, {
    entireHomeMonthlyRent: MONTHLY_RENT,
    entireHomeProrateMethod: "daily_rate",
    entireHomeDailyRentRate: DAILY_RENT_RATE,
  });
  if (fees.length > 0) sub = applyListingFeesToSubmission(sub, fees);
  return normalizeManagerListingSubmissionV1(sub);
}

/** Tacoma, not Seattle: a monthly fee bills beside rent everywhere else. */
function publish(sub: ManagerListingSubmissionV1): MockProperty {
  const property: MockProperty = {
    id: PROPERTY_ID,
    title: "Whole House",
    tagline: "",
    address: "1400 Pacific Ave, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
    beds: 3,
    baths: 2,
    rentLabel: "$3,600/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Whole House",
    unitLabel: "Whole house",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: sub,
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

const ROOM_CHOICE = `${PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-1`;

function applicantRow(): DemoApplicantRow {
  return {
    id: "app-whole-house",
    name: "Dana Tenant",
    email: "whole-house@example.com",
    property: "Whole House",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: ROOM_CHOICE,
    managerUserId: MANAGER_ID,
    application: {
      propertyId: PROPERTY_ID,
      roomChoice1: ROOM_CHOICE,
      rentalType: "standard",
      leaseTerm: "Long-term",
      leaseStart: LEASE_START,
      leaseEnd: LEASE_END,
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

const quoteFor = (sub: ManagerListingSubmissionV1, property: MockProperty) =>
  applicantListingQuote(sub, {
    roomChoice1: ROOM_CHOICE,
    leaseTerm: "Long-term",
    leaseStart: LEASE_START,
    leaseEnd: LEASE_END,
    listingProperty: property,
  });

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("a whole-unit listing priced per day", () => {
  it("quotes the partial months on the manager's own day rate, as the lease and ledger bill them", () => {
    const sub = wholeHouse();
    const property = publish(sub);
    const quote = quoteFor(sub, property);

    expect(quote?.proration?.firstMonth).toMatchObject({ billableDays: 17, daysInMonth: 31 });
    expect(quote?.proration?.lastMonth).toMatchObject({ billableDays: 14, daysInMonth: 31 });
    expect(quote?.proration?.firstMonth?.amount).toBeCloseTo(17 * DAILY_RENT_RATE, 2);
    expect(quote?.proration?.lastMonth?.amount).toBeCloseTo(14 * DAILY_RENT_RATE, 2);

    const billing = resolveLeaseProrationInputForApplicant(applicantRow());
    expect(billing.method).toBe("daily_rate");
    expect(billing.dailyRentRate).toBe(DAILY_RENT_RATE);
    const first = computeProratedFirstMonthTotals({
      monthlyRent: MONTHLY_RENT,
      monthlyUtilities: 0,
      leaseStart: LEASE_START,
      leaseEnd: LEASE_END,
      ...billing,
    });
    const last = computeProratedLastMonthTotals({
      monthlyRent: MONTHLY_RENT,
      monthlyUtilities: 0,
      leaseEnd: LEASE_END,
      ...billing,
      endsInsideFirstMonth: false,
    });
    expect(quote?.proration?.firstMonth?.amount).toBeCloseTo(first.proratedRent, 2);
    expect(quote?.proration?.lastMonth?.amount).toBeCloseTo(last.proratedRent, 2);
  });

  it("prices a recurring fee's partial month on the fee's own typed day rate", () => {
    const sub = wholeHouse([
      { id: "fee-parking", presetId: null, label: "Parking", amount: "90", frequency: "monthly", dailyRate: 4 },
    ]);
    const property = publish(sub);
    const quote = quoteFor(sub, property);

    expect(quote?.proration?.firstMonth?.amount).toBeCloseTo(17 * DAILY_RENT_RATE + 17 * 4, 2);
    expect(quote?.proration?.lastMonth?.amount).toBeCloseTo(14 * DAILY_RENT_RATE + 14 * 4, 2);
  });
});
