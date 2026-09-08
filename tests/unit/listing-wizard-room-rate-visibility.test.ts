/**
 * A room is priced by the lease types the LISTING offers, and by nothing else.
 *
 * An empty "rent / night" beside a long-term room invites a manager to type a
 * number nothing will ever bill: the application flow refuses a lease type the
 * listing does not offer, so that rate has no way to reach a charge. Each price
 * appears only once the term that uses it does.
 */
import { describe, expect, it } from "vitest";
import { roomRateVisibility } from "@/components/portal/listing-wizard-v2/listing-editor";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const sub = (over: Partial<ManagerListingSubmissionV1>) => over as ManagerListingSubmissionV1;

describe("which prices a room may show", () => {
  it("offers nothing to price until a lease type is chosen", () => {
    const v = roomRateVisibility(sub({ allowedLeaseTerms: [] }));
    expect(v.monthly).toBe(false);
    expect(v.shortTerm).toBe(false);
    expect(v.airbnb).toBe(false);
    expect(v.nightly).toBe(false);
  });

  it("asks for a monthly figure for long-term, custom and month-to-month alike", () => {
    for (const term of [LONG_TERM_LEASE_TERM, CUSTOM_LEASE_TERM, "Month-to-Month"]) {
      expect(roomRateVisibility(sub({ allowedLeaseTerms: [term] })).monthly).toBe(true);
    }
  });

  it("prorates only a term that can start mid-month", () => {
    // A month-to-month let renews on a whole month, so there is no partial
    // month to split; a custom term starting on the 14th is exactly that case.
    expect(roomRateVisibility(sub({ allowedLeaseTerms: [CUSTOM_LEASE_TERM] })).prorate).toBe(true);
    expect(roomRateVisibility(sub({ allowedLeaseTerms: [LONG_TERM_LEASE_TERM] })).prorate).toBe(true);
    expect(roomRateVisibility(sub({ allowedLeaseTerms: ["Month-to-Month"] })).prorate).toBe(false);
  });

  it("shows weekly and nightly prices only for a short-term stay", () => {
    const v = roomRateVisibility(sub({ shortTermRentalsAllowed: true }));
    expect(v.shortTerm).toBe(true);
    expect(v.nightly).toBe(true);
  });

  it("gives Airbnb a nightly rate but no short-stay charges", () => {
    // An Airbnb booking is taken off PropLane, so no deposit or move-in fee is
    // raised here for it to attach to.
    const v = roomRateVisibility(sub({ allowedLeaseTerms: [AIRBNB_LEASE_TERM], airbnbRentalsAllowed: true }));
    expect(v.airbnb).toBe(true);
    expect(v.nightly).toBe(true);
    expect(v.shortStayCharges).toBe(false);
  });
});
