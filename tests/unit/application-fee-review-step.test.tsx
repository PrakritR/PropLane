// @vitest-environment jsdom
//
// Resident audit F8 / manager audit F-FIN-1: the wizard's Review step (11)
// printed `Application fee  $50.00` — the LISTING's published fee — and the
// very next screen (12) said "No application fee is required. Your first
// application fee already covers additional applications." Two numbers for one
// charge, one screen apart.
//
// This drives the REAL step bodies, so it catches a re-wiring that reverts the
// review row to `displayLabel`, not just a change to the copy helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const PROPERTY_ID = "mgr-test-fee";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: (id: string) =>
      id === PROPERTY_ID
        ? {
            id: PROPERTY_ID,
            title: "Alder Row",
            listingSubmission: { ...createDefaultListingSubmission(), applicationFee: "$50" },
            managerUserId: "mgr-1",
          }
        : undefined,
  };
});

function props(over: Partial<WizardStepsProps>): WizardStepsProps {
  const noop = () => {};
  return {
    step: 11,
    form: { ...createInitialRentalWizardState(), propertyId: PROPERTY_ID, email: "r@example.com" },
    errors: {},
    mode: "portal",
    propertyOptions: [{ value: PROPERTY_ID, label: "Alder Row" }],
    patch: noop,
    applicationFeeGate: { needsFee: false, paid: true, displayLabel: "$50.00", amount: 50, waived: true },
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

const WAIVER_SENTENCE =
  "No application fee is required. Your first application fee already covers additional applications.";

// Review is step 10 and the application-fee step is step 11 (see the
// `step === 10` / `step === 11` branches in rental-wizard-steps.tsx). These were
// 11/12 here, one past their real positions, so "Review" rendered the fee step
// and "the fee step" rendered nothing at all. The waived cases failed loudly;
// the fee-is-due case passed by accident, because the fee step also prints an
// "Application fee" label when one is owed.
describe("application fee: Review and the fee step agree (F8)", () => {
  it("Review shows $0.00 and states the waiver, instead of the bare published $50.00", () => {
    render(<RentalWizardStepBody {...props({ step: 10 })} />);
    const row = screen.getByText("Application fee").closest("div")!.parentElement!;
    expect(row.textContent).toContain("$0.00");
    expect(row.textContent).toContain(WAIVER_SENTENCE);
    // The $50 is still named — as the listing's published fee, not as what's owed.
    expect(row.textContent).toContain("$50.00");
  });

  it("the fee step one screen later says the SAME thing", () => {
    render(<RentalWizardStepBody {...props({ step: 11 })} />);
    expect(screen.getByText(WAIVER_SENTENCE)).toBeTruthy();
  });

  it("a fee that IS due still shows the amount on Review", () => {
    render(
      <RentalWizardStepBody
        {...props({
          step: 10,
          applicationFeeGate: { needsFee: true, paid: false, displayLabel: "$50.00", amount: 50, waived: false },
        })}
      />,
    );
    const row = screen.getByText("Application fee").closest("div")!.parentElement!;
    expect(row.textContent).toContain("$50.00");
    expect(row.textContent).not.toContain(WAIVER_SENTENCE);
  });
});
