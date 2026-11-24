/**
 * @vitest-environment jsdom
 *
 * AXI-153 — "when the application is opened by a potential tenant the applicaiton
 * form should be prefilled out with the information of the property so they have
 * an easier time filling out application."
 *
 * The link prefill already carried property, room, bundle, phone and rental type.
 * Lease term did not: a listing that offers exactly ONE term still made the
 * applicant open a dropdown and pick the only option in it. Driven through the real
 * wizard: what the applicant SEES selected on step 1 is the prefill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import { onlyOfferedStoredTerm } from "@/lib/rental-application/applicant-lease-term";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const PID = "mgr-prefill-listing";

function seedListing(allowedLeaseTerms: string[], shortTermRentalsAllowed = false): void {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = allowedLeaseTerms;
  sub.shortTermRentalsAllowed = shortTermRentalsAllowed;
  const property: MockProperty = {
    id: PID,
    title: "Prefill House",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 2,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Prefill House",
    unitLabel: "2 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-prefill",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

function mount(allowedLeaseTerms: string[], shortTermRentalsAllowed = false) {
  seedListing(allowedLeaseTerms, shortTermRentalsAllowed);
  return render(
    <RentalApplicationWizard showToast={() => {}} mode="public" layout="embedded" linkedPropertyId={PID} />,
  );
}

/** The lease-term toggle a person sees; `null` when the listing offers one side and there is nothing to pick. */
function selectedToggle(): string | null {
  const on = screen.queryAllByRole("radio").find((node) => node.getAttribute("aria-checked") === "true");
  return on ? (on.textContent ?? "").trim() : null;
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("lease term prefill from the listing", () => {
  it("opens on the listing's long-term lease when it offers both sides, never a nightly short stay", async () => {
    mount(["Long-term", "Short-Term Stay"], true);
    // Both sides are offered, so the applicant sees the toggle — already on Long-term.
    await waitFor(() => expect(screen.queryAllByRole("radio").length).toBe(2));
    expect(screen.queryAllByRole("radio").map((n) => (n.textContent ?? "").trim())).toEqual(["Long-term", "Short-term"]);
    await waitFor(() => expect(selectedToggle()).toBe("Long-term"));
  });

  it("prefills the only term a single-term listing offers: the dates step is already open on it", async () => {
    mount(["Month-to-Month"]);
    // Month-to-month asks the move-in date and never a move-out date; the applicant picked nothing to get here.
    await waitFor(() => expect(document.getElementById("leaseStart")).not.toBeNull());
    expect(document.getElementById("leaseEnd")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("asks when the listing offers more than one long-term shape, instead of guessing", async () => {
    mount(["Long-term", "Month-to-Month"]);
    await waitFor(() => expect(document.getElementById("leaseStart")).not.toBeNull());
    // A move-out date is asked, so the prefill did NOT silently pick Month-to-month.
    expect(document.getElementById("leaseEnd")).not.toBeNull();
  });

  it("the sole-term rule itself: one lease type prefills, two is a question", () => {
    expect(onlyOfferedStoredTerm(["Long-term"])).toBe("Long-term");
    expect(onlyOfferedStoredTerm(["Long-term", "Short-Term Stay"])).toBeNull();
  });
});
