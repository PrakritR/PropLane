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
import { cleanup, render, screen, within } from "@testing-library/react";
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
    step: 7,
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

// Review, consent and the application fee are ONE screen (step 7, "Review, sign and pay"): the summary
// first, then the fee. Both parts still have to say the same thing about the fee. The fee-is-due case
// finds the review row inside the summary, because the fee card also prints an "Application fee" label
// when one is owed.
function reviewFeeRow(container: HTMLElement): HTMLElement {
  const summary = container.querySelector<HTMLElement>("[data-jr-review-answers]")!;
  return within(summary).getByText("Application fee").closest("div")!.parentElement!;
}

describe("application fee: Review and the fee agree on one screen (F8)", () => {
  it("Review shows $0.00 and states the waiver, instead of the bare published $50.00", () => {
    const { container } = render(<RentalWizardStepBody {...props({})} />);
    const row = reviewFeeRow(container);
    expect(row.textContent).toContain("$0.00");
    expect(row.textContent).toContain(WAIVER_SENTENCE);
    // The $50 is still named — as the listing's published fee, not as what's owed.
    expect(row.textContent).toContain("$50.00");
  });

  it("the fee below the summary says the SAME thing", () => {
    const { container } = render(<RentalWizardStepBody {...props({})} />);
    const summary = container.querySelector<HTMLElement>("[data-jr-review-answers]")!;
    // The summary's fee row carries the sentence inside its note; the fee section states it on its own.
    expect(summary.textContent).toContain(WAIVER_SENTENCE);
    expect(screen.getByText(WAIVER_SENTENCE)).toBeTruthy();
  });

  it("a manager filling the form on someone's behalf is never asked for the fee", () => {
    render(<RentalWizardStepBody {...props({ mode: "manager" })} />);
    // Only the summary's note names it; the fee section is not drawn.
    expect(screen.queryByText(WAIVER_SENTENCE)).toBeNull();
  });

  it("a fee that IS due still shows the amount on Review", () => {
    const { container } = render(
      <RentalWizardStepBody
        {...props({
          applicationFeeGate: { needsFee: true, paid: false, displayLabel: "$50.00", amount: 50, waived: false },
        })}
      />,
    );
    const row = reviewFeeRow(container);
    expect(row.textContent).toContain("$50.00");
    expect(row.textContent).not.toContain(WAIVER_SENTENCE);
  });
});
