/**
 * @vitest-environment jsdom
 *
 * The applicant's "Lease term" dropdown, driven through the real wizard step.
 *
 * A listing configured before AXI-143 still stores 3/6/9/12-Month, and this
 * dropdown echoed them verbatim — so a prospect was offered lengths the manager
 * can no longer pick, while Month-to-Month and Custom were absent entirely.
 * The dropdown now offers what the LISTING offers, with retired lengths
 * collapsed onto Long-term. Storage is untouched.
 */
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

const PID = "prop-lease-terms";
/** Exactly what the manager's screenshot showed a listing storing. */
const LEGACY_STORED = ["3-Month", "6-Month", "9-Month", "12-Month", "Long-term"];

function seedListing(allowedLeaseTerms: string[], shortTerm = false): void {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = allowedLeaseTerms;
  sub.shortTermRentalsAllowed = shortTerm;
  const property: MockProperty = {
    id: PID,
    title: "Legacy Terms House",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 3,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Legacy Terms House",
    unitLabel: "3 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-lease-terms",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

/** Step 3 carries Lease term; render it exactly as the apply page does. */
function renderLeaseTermStep(allowedLeaseTerms: string[], leaseTerm = "", shortTerm = false) {
  seedListing(allowedLeaseTerms, shortTerm);
  const noop = () => {};
  return render(
    <RentalWizardStepBody
      step={3}
      form={{ ...createInitialRentalWizardState(), propertyId: PID, leaseTerm }}
      errors={{}}
      mode="public"
      propertyOptions={[]}
      patch={noop}
      applicationFeeGate={undefined as unknown as WizardStepsProps["applicationFeeGate"]}
      occupancySyncEpoch={0}
      showAvailabilityWarnings={false}
      setPhone={noop}
      setLandlordPhone={noop}
      setPrevLandlordPhone={noop}
      setSupervisorPhone={noop}
      setRef1Phone={noop}
      setRef2Phone={noop}
      setSsn={noop}
      goToStep={noop}
      editFromReview={noop}
    />,
  );
}

/**
 * The lease-term choices a person actually sees: the field renders a menu
 * rather than a native <select>, so open it the way they would and read the
 * option rows. The placeholder row ("Select lease length") is excluded.
 */
function openLeaseTermMenu(): string[] {
  const label = screen.getByText(/^Lease term/i);
  const field = label.closest("div");
  const trigger = field?.querySelector("button");
  if (!trigger) throw new Error("no lease term trigger rendered");
  fireEvent.click(trigger);
  return Array.from(document.querySelectorAll('[role="option"]'))
    // The selected row prefixes a check glyph; it is decoration, not the term.
    .map((el) => (el.textContent ?? "").replace(/^[\u2713\u2714]\s*/, "").trim())
    .filter((t) => t && !/^select lease length$/i.test(t));
}

afterEach(() => cleanup());

describe("apply wizard — Lease term options come from the listing", () => {
  it("never offers a retired length a listing still stores", () => {
    renderLeaseTermStep(LEGACY_STORED);
    const terms = openLeaseTermMenu();
    for (const retired of ["3-Month", "6-Month", "9-Month", "12-Month"]) {
      expect(terms, `${retired} is retired and must not be offered`).not.toContain(retired);
    }
    expect(terms).toContain("Long-term");
  });

  it("offers exactly what the listing offers, in canonical order", () => {
    renderLeaseTermStep(["12-Month", "Month-to-Month", "Custom"]);
    expect(openLeaseTermMenu()).toEqual(["Long-term", "Month-to-Month", "Custom"]);
  });

  it("carries the listing's short stay when it permits one", () => {
    renderLeaseTermStep(["12-Month"], "", true);
    expect(openLeaseTermMenu()).toContain("Short-Term Stay");
  });

  it("keeps a resumed draft's own answer selectable rather than blanking it", () => {
    // An application started while 12-Month was still offered must not have its
    // answer silently dropped just because the term is no longer offered afresh.
    renderLeaseTermStep(LEGACY_STORED, "12-Month");
    expect(openLeaseTermMenu()).toContain("12-Month");
  });
});
