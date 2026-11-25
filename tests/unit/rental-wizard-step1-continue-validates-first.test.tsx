/**
 * @vitest-environment jsdom
 *
 * Step 1 Continue shows its validation errors instantly: the room-occupancy read behind
 * "Checking rooms…" (`GET /api/public/approved-room-occupancy?fresh=1`) runs only once the step
 * validates, so a missing move-in date is an error the applicant sees immediately rather than one
 * that waits on a network round trip. Driven through the real wizard.
 *
 * Oracle: the message comes from `apply-validation.ts` ("Lease start date is required."), a module
 * independent of the component under test, and the route is the one the public occupancy read owns.
 * Plausible wrong behaviour this rejects: validating after the refresh (the applicant then waits on,
 * and pays egress for, a read the step was never going to pass).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

const PID = "prop-step1-continue";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`propertyId=${PID}&listingRoomId=room-a`),
}));

function seedListing(): void {
  const sub = createDefaultListingSubmission();
  sub.listingPlaceCategoryId = "shared_home";
  sub.rentalModelStamp = "shared_home";
  sub.rooms = [{ ...sub.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 900 }];
  sub.allowedLeaseTerms = ["Long-term"];
  const property: MockProperty = {
    id: PID,
    title: "Continue House",
    tagline: "Test",
    address: "1200 Pacific Ave, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
    beds: 3,
    baths: 1,
    rentLabel: "$900/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Continue House",
    unitLabel: "3 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-step1-continue",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

/** The Continue-time read only: `fresh=1` is the uncached one the spinner waits on (the page's own cached read runs on mount). */
const freshOccupancyCalls = () =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/public/approved-room-occupancy?fresh=1"));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // `/` is the demo surface, and demo mode skips the occupancy read entirely.
  window.history.replaceState(null, "", "/rent/apply");
  Element.prototype.scrollIntoView = () => {};
  fetchMock = vi.fn((url: string) =>
    // A fresh read that never settles: if the step were validated AFTER it, the error below could never render.
    String(url).includes("/api/public/approved-room-occupancy?fresh=1")
      ? new Promise<Response>(() => {})
      : Promise.resolve(new Response(JSON.stringify({ rooms: [] }), { status: 200, headers: { "content-type": "application/json" } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  seedListing();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const continueButton = () => screen.getByRole("button", { name: /^Continue$|^Checking rooms/ });

describe("step 1 Continue", () => {
  it("shows the missing move-in date without waiting on the room-availability read", async () => {
    render(<RentalApplicationWizard showToast={() => {}} mode="public" layout="embedded" linkedPropertyId={PID} />);
    await waitFor(() => expect(document.getElementById("leaseStart")).not.toBeNull());
    // The room came from the link, so a valid step 1 WOULD pay for the fresh read.
    expect(document.querySelector('[data-wizard-field="roomChoice1"]')?.textContent).toContain("Room A");

    fireEvent.click(continueButton());

    // The fresh read never settles here, so an error that appears at all is an error that did not wait for it.
    await waitFor(() => expect(screen.getByText("Lease start date is required.")).toBeTruthy());
    expect(freshOccupancyCalls()).toHaveLength(0);
    expect(continueButton().textContent).not.toContain("Checking rooms");
  });
});
