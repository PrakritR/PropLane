/**
 * @vitest-environment jsdom
 *
 * The applicant's "Lease term" dropdown, driven through the real wizard step.
 *
 * The applicant picks exactly Long-term or Short-term, filtered to what the listing offers (captain, Oct 3 2026).
 * Month-to-month and custom dates are options of the long-term lease -- a "Length" under Long-term and the
 * date pickers -- not terms of their own. The STORED term is translated at the edge, so a retired length,
 * Custom and Month-to-Month all read as Long-term, and what the server receives still routes through the
 * lease mapping and the one fee resolver.
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

let rentByRoom = false;

function seedListing(allowedLeaseTerms: string[], shortTerm = false): void {
  const sub = createDefaultListingSubmission();
  if (rentByRoom) {
    sub.listingPlaceCategoryId = "shared_home";
    sub.rentalModelStamp = "shared_home";
    sub.rooms = [{ ...sub.rooms[0]!, id: "room-a", name: "Room A" }];
  }
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

/** Step 1 opens with the lease question and carries Lease term; render it exactly as the apply page does. */
function renderLeaseTermStep(
  allowedLeaseTerms: string[],
  leaseTerm = "",
  shortTerm = false,
  patch: (next: Record<string, unknown>) => void = () => {},
  extra: Record<string, unknown> = {},
  step = 1,
) {
  seedListing(allowedLeaseTerms, shortTerm);
  const noop = () => {};
  return render(
    <RentalWizardStepBody
      step={step}
      form={{ ...createInitialRentalWizardState(), propertyId: PID, leaseTerm, ...extra }}
      errors={{}}
      mode="public"
      propertyOptions={[]}
      patch={patch as WizardStepsProps["patch"]}
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
 * The lease-term choices a person actually sees: the field renders a menu rather than a native <select>, so open
 * it the way they would and read the option rows. The placeholder row ("Select a lease term") is excluded.
 */
function leaseTermTrigger(): HTMLElement {
  const label = screen.getByText(/^Lease term/i);
  const trigger = label.closest("div")?.querySelector("button");
  if (!trigger) throw new Error("no lease term trigger rendered");
  return trigger as HTMLElement;
}

function openLeaseTermMenu(): string[] {
  fireEvent.click(leaseTermTrigger());
  return Array.from(document.querySelectorAll('[role="option"]'))
    // The selected row prefixes a check glyph; it is decoration, not the term.
    .map((el) => (el.textContent ?? "").replace(/^[\u2713\u2714]\s*/, "").trim())
    .filter((t) => t && !/^select a lease term$/i.test(t));
}

function pick(label: string) {
  const option = screen.getAllByRole("option").find((node) => (node.textContent ?? "").replace(/^[\u2713\u2714]\s*/, "").trim() === label)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 0, clientY: 0 });
}

afterEach(() => cleanup());

describe("apply wizard — Lease term lists only the lease types the property enabled", () => {
  it("never offers a retired length a listing still stores; Month-to-month and Custom are offered when enabled", () => {
    renderLeaseTermStep(LEGACY_STORED);
    expect(openLeaseTermMenu()).toEqual(["Long-term"]);
    cleanup();
    renderLeaseTermStep(["12-Month", "Month-to-Month", "Custom"]);
    expect(openLeaseTermMenu()).toEqual(["Long-term", "Custom", "Month-to-month"]);
  });

  it("offers Short-term only when the listing permits a short stay", () => {
    renderLeaseTermStep(["12-Month"], "", true);
    expect(openLeaseTermMenu()).toEqual(["Long-term", "Short-term"]);
    cleanup();
    renderLeaseTermStep(["12-Month"], "", false);
    expect(openLeaseTermMenu()).toEqual(["Long-term"]);
  });

  it("lists all four, in order, when all four are enabled", () => {
    renderLeaseTermStep(["Month-to-Month", "Custom", "Long-term", "Short-Term Stay"], "", true);
    expect(openLeaseTermMenu()).toEqual(["Long-term", "Short-term", "Custom", "Month-to-month"]);
  });

  it("the placeholder reads 'Select a lease term'", () => {
    renderLeaseTermStep(["Long-term"]);
    expect(leaseTermTrigger().textContent).toContain("Select a lease term");
    expect(screen.queryByText("Select lease length")).toBeNull();
  });

  it("keeps a resumed draft's own stored answer selected, reading as its lease type", () => {
    renderLeaseTermStep(LEGACY_STORED, "12-Month");
    expect(leaseTermTrigger().textContent).toContain("Long-term");
    cleanup();
    renderLeaseTermStep(["Custom"], "Custom");
    expect(leaseTermTrigger().textContent).toContain("Custom");
    cleanup();
    renderLeaseTermStep(["Long-term", "Short-Term Stay"], "Short-Term Stay", true);
    expect(leaseTermTrigger().textContent).toContain("Short-term");
  });

  it("Custom shows the start and end date pickers; Month-to-month only the start date", () => {
    renderLeaseTermStep(["Custom"], "Custom", false, () => {}, {}, 3);
    expect(document.getElementById("leaseStart")).not.toBeNull();
    expect(document.getElementById("leaseEnd")).not.toBeNull();
    cleanup();
    renderLeaseTermStep(["Long-term", "Month-to-Month"], "Month-to-Month", false, () => {}, {}, 3);
    expect(document.getElementById("leaseStart")).not.toBeNull();
    expect(document.getElementById("leaseEnd")).toBeNull();
  });

  it("has ONE Lease term select: no separate Length control and no month-to-month price notice", () => {
    renderLeaseTermStep(["Long-term", "Month-to-Month"], "Month-to-Month");
    expect(document.querySelector("[data-attr='rental-wizard-lease-length']")).toBeNull();
    expect(screen.queryByText(/^Length$/)).toBeNull();
    expect(document.body.textContent).not.toContain("$25");
    expect(document.body.textContent).not.toMatch(/additional .* charge to rent/i);
  });

  it("translates the pick to the existing stored term the server routes on", () => {
    const patched: Record<string, unknown>[] = [];
    const all = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];
    const picks: [string, Record<string, unknown>][] = [
      ["Long-term", { leaseTerm: "Long-term", rentalType: "standard" }],
      ["Short-term", { leaseTerm: "Short-Term Stay", rentalType: "short_term" }],
      ["Custom", { leaseTerm: "Custom", rentalType: "standard" }],
      ["Month-to-month", { leaseTerm: "Month-to-Month", rentalType: "standard", leaseEnd: "" }],
    ];
    for (const [label, expected] of picks) {
      renderLeaseTermStep(all, "", true, (next) => patched.push(next));
      openLeaseTermMenu();
      pick(label);
      expect(patched.at(-1)).toMatchObject(expected);
      cleanup();
    }
  });
});

describe("apply wizard — step labels", () => {
  it("room choices read '1st choice / 2nd choice / 3rd choice' in sentence case, and required fields carry no asterisk", () => {
    rentByRoom = true;
    renderLeaseTermStep(["Long-term"], "Long-term");
    rentByRoom = false;
    for (const label of ["1st choice", "2nd choice", "3rd choice"]) {
      const node = screen.getByText(label);
      expect(node.className).not.toContain("uppercase");
    }
    expect(document.body.textContent).not.toMatch(/\*/);
    // The lease term label says "(required)" to assistive tech only.
    expect(screen.getByText(/^Lease term/i).textContent).not.toContain("*");
  });
});
