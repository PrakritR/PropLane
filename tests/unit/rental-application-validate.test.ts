import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { validateRentalWizardStep } from "@/lib/rental-application/validate";

/**
 * A stay that starts in the FUTURE, computed rather than written down. These were the literals
 * "2026-08-01"/"2026-08-15", so the suite went red on its own the day the start date fell into
 * the past and validation began reporting "Lease start date cannot be in the past."
 */
function futureStayDates(): { leaseStart: string; leaseEnd: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date();
  start.setDate(start.getDate() + 30);
  const end = new Date(start);
  end.setDate(end.getDate() + 14);
  return { leaseStart: iso(start), leaseEnd: iso(end) };
}

describe("rental-application validate", () => {
  it("requires group choice on step 1", () => {
    const state = createInitialRentalWizardState();
    const errors = validateRentalWizardStep(1, state);
    expect(errors.applyingAsGroup).toBeDefined();
  });

  it("passes step 1 when not applying as group", () => {
    const state = {
      ...createInitialRentalWizardState(),
      applyingAsGroup: "no" as const,
      hasCosigner: "no" as const,
    };
    expect(validateRentalWizardStep(1, state)).toEqual({});
  });

  it("requires group choice on step 1 even when the property offers lease bundles", () => {
    const state = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-with-bundles",
      rentalType: "short_term" as const,
      hasCosigner: "no" as const,
    };
    const property = {
      id: "prop-with-bundles",
      listingSubmission: {
        ...createDefaultListingSubmission(),
        shortTermRentalsAllowed: true,
        bundles: [
          {
            id: "bundle-a",
            label: "Two rooms",
            price: "$1,700/mo",
            strikethrough: "",
            promo: "",
            roomsLine: "Rooms A + B",
            shortTermEnabled: true,
            shortTermNightlyRent: "$85",
          },
        ],
      },
    };
    const errors = validateRentalWizardStep(1, state, { property });
    expect(errors.applyingAsGroup).toContain("group");
  });

  it("requires cosigner choice on step 1 when enabled", () => {
    const state = { ...createInitialRentalWizardState(), applyingAsGroup: "no" as const };
    const errors = validateRentalWizardStep(1, state);
    expect(errors.hasCosigner).toBeDefined();
  });

  it("no longer offers Zelle for the application fee — it resolves to platform ACH", () => {
    // bc91cc80 made checkout Stripe-only. resolveApplicationFeePayChannel has no
    // zelle branch left, so a listing still carrying zelle config falls through to
    // ACH and the manual "Check payment" confirmation is unreachable. Asserting the
    // absence keeps Zelle from quietly returning to the application-fee flow.
    const sub = {
      ...createDefaultListingSubmission(),
      applicationFee: "$50",
      applicationFeeChannels: ["zelle"] as const,
      zellePaymentsEnabled: true,
      zelleContact: "pay@example.com",
    };
    const state = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-zelle",
      applicationFeePayChannel: "zelle" as const,
      applicationFeeZelleSentConfirmed: false,
    };
    const errors = validateRentalWizardStep(11, state, {
      property: { id: "prop-zelle", listingSubmission: sub },
    });
    expect(errors.applicationFeeZelleSentConfirmed).toBeUndefined();
  });

  it("rejects a future date of birth on its own terms, not as an age error", () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const iso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    const state = { ...createInitialRentalWizardState(), dateOfBirth: iso };
    const errors = validateRentalWizardStep(2, state);
    expect(errors.dateOfBirth).toBe("Date of birth cannot be in the future.");
    expect(errors.dateOfBirth).not.toContain("18 years");
  });

  it("still rejects an under-18 date of birth with the age message", () => {
    const child = new Date();
    child.setFullYear(child.getFullYear() - 5);
    const iso = `${child.getFullYear()}-${String(child.getMonth() + 1).padStart(2, "0")}-${String(child.getDate()).padStart(2, "0")}`;
    const state = { ...createInitialRentalWizardState(), dateOfBirth: iso };
    const errors = validateRentalWizardStep(2, state);
    expect(errors.dateOfBirth).toContain("at least 18 years old");
  });

  it("accepts an adult date of birth", () => {
    const adult = new Date();
    adult.setFullYear(adult.getFullYear() - 30);
    const iso = `${adult.getFullYear()}-${String(adult.getMonth() + 1).padStart(2, "0")}-${String(adult.getDate()).padStart(2, "0")}`;
    const state = { ...createInitialRentalWizardState(), dateOfBirth: iso };
    const errors = validateRentalWizardStep(2, state);
    expect(errors.dateOfBirth).toBeUndefined();
  });

  it("rejects a short-term lease term on a listing that does not allow short-term stays", () => {
    const sub = { ...createDefaultListingSubmission(), shortTermRentalsAllowed: false };
    const state = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-no-short",
      rentalType: "short_term" as const,
      leaseTerm: "Short-Term Stay",
    };
    const errors = validateRentalWizardStep(3, state, {
      property: { id: "prop-no-short", listingSubmission: sub },
    });
    expect(errors.leaseTerm).toContain("short-term");
  });

  it("passes step 11 when manual application fee is verified", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      applicationFee: "$50",
      applicationFeeChannels: ["venmo"] as const,
      venmoPaymentsEnabled: true,
      venmoContact: "@landlord",
    };
    const state = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-venmo",
      applicationFeePayChannel: "venmo" as const,
      applicationFeeZelleSentConfirmed: true,
    };
    const errors = validateRentalWizardStep(11, state, {
      property: { id: "prop-venmo", listingSubmission: sub },
    });
    expect(errors.applicationFeeZelleSentConfirmed).toBeUndefined();
  });

  it("offers Short-Term Stay as a lease term exactly when the listing permits it", () => {
    const base = createDefaultListingSubmission();
    expect(
      resolveAllowedLeaseTerms({ ...base, shortTermRentalsAllowed: true }),
    ).toContain(SHORT_TERM_LEASE_TERM);
    expect(
      resolveAllowedLeaseTerms({ ...base, shortTermRentalsAllowed: false }),
    ).not.toContain(SHORT_TERM_LEASE_TERM);
  });

  it("requires check-in and check-out times for a short-term application on a permitting listing", () => {
    const sub = { ...createDefaultListingSubmission(), shortTermRentalsAllowed: true };
    const state = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-short-term",
      roomChoice1: "prop-short-term::room-1",
      rentalType: "short_term" as const,
      leaseTerm: SHORT_TERM_LEASE_TERM,
      ...futureStayDates(),
    };
    const missing = validateRentalWizardStep(3, state, {
      property: { id: "prop-short-term", listingSubmission: sub },
    });
    expect(missing.leaseTerm).toBeUndefined();
    expect(missing.shortTermCheckInTime).toContain("Check-in time");
    expect(missing.shortTermCheckOutTime).toContain("Check-out time");

    expect(missing.shortTermRulesAck).toContain("house rules");

    const filled = validateRentalWizardStep(
      3,
      { ...state, shortTermCheckInTime: "15:00", shortTermCheckOutTime: "11:00", shortTermRulesAck: true },
      { property: { id: "prop-short-term", listingSubmission: sub } },
    );
    expect(filled).toEqual({});
  });

  it("rejects a short-term application when the listing does not permit short-term stays", () => {
    const sub = { ...createDefaultListingSubmission(), shortTermRentalsAllowed: false };
    const state = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-no-short-term",
      roomChoice1: "prop-no-short-term::room-1",
      rentalType: "short_term" as const,
      leaseTerm: SHORT_TERM_LEASE_TERM,
      ...futureStayDates(),
      shortTermCheckInTime: "15:00",
      shortTermCheckOutTime: "11:00",
    };
    const errors = validateRentalWizardStep(3, state, {
      property: { id: "prop-no-short-term", listingSubmission: sub },
    });
    expect(errors.leaseTerm).toContain("does not allow short-term stays");
  });
});
