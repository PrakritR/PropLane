// @vitest-environment jsdom
//
// EVIDENCE HARNESS for the four remaining "two screens, two answers" findings:
//
//  F-FIN-1 / resident F8 — the wizard's Review step printed the LISTING's
//  published application fee while the very next screen said no fee was due.
//  F-FIN-2 — a nameless draft stored the literal name "Applicant", which then
//  overwrote the resident's real name on every finance row for that email.
//  F-DRAFT-2 — an unfinished draft's listing preview printed a backwards band,
//  "from $500–$100/mo", and a $450/mo listing printed "from $500–$550/mo".
//  F7 — resident application rows were byte-identical, so a resident could not
//  tell one from another.
//
// The fee case drives the REAL wizard step bodies; the rest exercise the real
// modules. With EVIDENCE_DIR set the fee row and a summary table are written out.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { applicantDisplayName, applicantSecondaryEmail, realApplicantName } from "@/lib/rental-application/applicant-name";
import { getListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";

const PROPERTY_ID = "mgr-evidence-fee";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: (id: string) =>
      id === "mgr-evidence-fee"
        ? {
            id: "mgr-evidence-fee",
            title: "Alder Row",
            listingSubmission: { ...createDefaultListingSubmission(), applicationFee: "$50" },
            managerUserId: "mgr-1",
          }
        : undefined,
  };
});

import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";

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

const WAIVER =
  "No application fee is required. Your first application fee already covers additional applications.";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
afterEach(cleanup);
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

describe("F-FIN-1 / F8 — Review and the fee step quote one number", () => {
  it("Review states the waiver beside the published fee, and step 11 says the same", () => {
    render(<RentalWizardStepBody {...props({ step: 10 })} />);
    const row = screen.getByText("Application fee").closest("div")!.parentElement!;
    // Capture before asserting, so the artifact exists in the pre-fix state too.
    captured.push({ name: "f8-review-fee-row", html: (row as HTMLElement).outerHTML });
    expect(row.textContent).toContain("$0.00");
    expect(row.textContent).toContain(WAIVER);
    expect(row.textContent).toContain("$50.00");
    cleanup();

    const feeStep = render(<RentalWizardStepBody {...props({ step: 11 })} />);
    captured.push({
      name: "f8-fee-step",
      html: (feeStep.container.firstElementChild as HTMLElement).innerHTML,
    });
    expect(screen.getByText(WAIVER)).toBeTruthy();
  });

  it("still prints the amount when a fee IS due", () => {
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
    expect(row.textContent).not.toContain(WAIVER);
  });
});

describe("F-FIN-2 — a nameless draft never names a person on a finance row", () => {
  it("resolves to the email, and never prints the same identity twice", () => {
    const nameless = { name: "", email: "nameless.draft@example.com" };
    const legacy = { name: "Applicant", email: "legacy.placeholder@example.com" };
    const real = { name: "Maya Chen", email: "maya@example.com" };

    expect(applicantDisplayName(nameless)).toBe("nameless.draft@example.com");
    expect(applicantDisplayName(legacy)).toBe("legacy.placeholder@example.com");
    expect(applicantDisplayName(real)).toBe("Maya Chen");
    // The email line is dropped when it IS the name line.
    expect(applicantSecondaryEmail(nameless)).toBe("");
    expect(applicantSecondaryEmail(real)).toBe("maya@example.com");
    // The finance-row indexer takes no name at all from a placeholder row, so
    // one nameless draft can no longer rename a resident everywhere.
    expect(realApplicantName("Applicant")).toBe("");
    expect(realApplicantName("Maya Chen")).toBe("Maya Chen");
  });
});

describe("F-DRAFT-2 — a listing never prints a price band that contradicts itself", () => {
  function listing(rentLabel: string): MockProperty {
    return {
      id: "p1",
      title: "Draft",
      rentLabel,
      beds: 2,
      baths: 1,
      tagline: "",
      address: "",
      zip: "98107",
      neighborhood: "Ballard",
      available: "",
      petFriendly: false,
      buildingId: "b1",
      buildingName: "Draft",
      unitLabel: "",
    } as MockProperty;
  }

  it("shows an em dash for a draft with no rent, and an ordered band otherwise", () => {
    // A draft writes `rentLabel: "$0"` — the exact input that printed the
    // backwards "from $500-$100/mo" band.
    const draft = getListingRichContent(listing("$0"));
    expect(draft.startingRentLabel).toBe("—");
    expect(draft.priceRangeLabel).toBe("—");

    // A rent below the old hardcoded $500 floor used to print a band that
    // started ABOVE the price shown right beside it.
    const cheap = getListingRichContent(listing("$450/mo"));
    expect(cheap.startingRentLabel).toBe("$450/mo");
    expect(cheap.priceRangeLabel).toBe("from $450–$550/mo");

    const normal = getListingRichContent(listing("$1,850/mo"));
    expect(normal.startingRentLabel).toBe("$1850/mo");
    expect(normal.priceRangeLabel).toBe("from $1725–$1950/mo");

     
    console.log(
      "\nF-DRAFT-2 evidence — listing price band\n" +
        `    no rent     → ${draft.startingRentLabel} / ${draft.priceRangeLabel}\n` +
        `    $450/mo     → ${cheap.startingRentLabel} / ${cheap.priceRangeLabel}\n` +
        `    $1,850/mo   → ${normal.startingRentLabel} / ${normal.priceRangeLabel}\n`,
    );
  });
});
