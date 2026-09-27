// @vitest-environment jsdom
//
// C174: the public apply flow's LAST step before the applicant pays (step 11,
// "the fee step") showed only the application fee amount — no itemized
// breakdown of what is due later at signing (security deposit, first month).
// That breakdown already existed elsewhere (the step-3 room picker's
// `ApplicantPaysCard`, and step 10's Review "Housing charges" section) but
// never on the final payment screen itself, where it matters most. This
// drives the real step body and asserts the fee step now renders the same
// itemized "What you pay" card, built from the same `applicantListingQuote`
// resolver step 10 already uses — so the numbers can never disagree.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const PROPERTY_ID = "mgr-test-fee-itemized";
const ROOM_CHOICE = `${PROPERTY_ID}::room-9`;

function itemizedListing(): ManagerListingSubmissionV1 {
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
        occupancyCapacity: 1,
        residentPricing: "per_room",
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

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: (id: string) =>
      id === PROPERTY_ID
        ? { id: PROPERTY_ID, title: "Brooklyn Row", listingSubmission: itemizedListing(), managerUserId: "mgr-1" }
        : undefined,
  };
});

function props(over: Partial<WizardStepsProps>): WizardStepsProps {
  const noop = () => {};
  return {
    step: 11,
    form: {
      ...createInitialRentalWizardState(),
      propertyId: PROPERTY_ID,
      email: "r@example.com",
      roomChoice1: ROOM_CHOICE,
      leaseTerm: LONG_TERM_LEASE_TERM,
    },
    errors: {},
    mode: "portal",
    propertyOptions: [{ value: PROPERTY_ID, label: "Brooklyn Row" }],
    patch: noop,
    applicationFeeGate: { needsFee: true, paid: false, displayLabel: "$50.00", amount: 50, waived: false },
    occupancySyncEpoch: 0,
    showAvailabilityWarnings: false,
    setPhone: noop,
    setLandlordPhone: noop,
    setPrevLandlordPhone: noop,
    setSupervisorPhone: noop,
    setRef1Phone: noop,
    setRef2Phone: noop,
    setSsn: noop,
    goToStep: noop,
    editFromReview: noop,
    ...over,
  } as WizardStepsProps;
}

afterEach(cleanup);

describe("fee step: itemized What you pay (C174)", () => {
  it("shows due-at-signing and then-each-month lines matching Review's numbers", () => {
    render(<RentalWizardStepBody {...props({})} />);

    expect(screen.getByText("What you pay")).toBeTruthy();
    // Same $250 security deposit and $1200 rent the shared listing/review-step
    // resolver produces — asserting the card renders these proves it read the
    // real quote rather than a placeholder.
    const card = screen.getByText("What you pay").closest("aside")!;
    expect(card.textContent).toContain("Security deposit");
    expect(card.textContent).toContain("$250");
    expect(card.textContent).toContain("Total at signing");
    expect(card.textContent).toContain("Then each month");
    expect(card.textContent).toContain("$1,200");
    expect(card.textContent).toContain("Application fee");
  });

  it("stays hidden until a room is chosen — never a guessed number", () => {
    render(<RentalWizardStepBody {...props({ form: { ...createInitialRentalWizardState(), propertyId: PROPERTY_ID, email: "r@example.com", roomChoice1: "" } })} />);
    expect(screen.queryByText("What you pay")).toBeNull();
  });
});
