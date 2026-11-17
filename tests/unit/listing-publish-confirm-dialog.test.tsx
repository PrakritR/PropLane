// @vitest-environment jsdom
// Publish with no photos asks once ("Publish anyway?"); Go back publishes nothing, Publish goes ahead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ListingEditorV2, LISTING_V2_STEPS } from "@/components/portal/listing-wizard-v2/listing-editor";
import { AIRBNB_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(onPublish: () => Promise<boolean>) {
  const base = createDefaultListingSubmission();
  const sub = {
    ...base,
    address: "142 Ash St",
    city: "Brooklyn",
    state: "NY",
    zip: "11201",
    listingPlaceCategoryId: "entire_home",
    allowedLeaseTerms: [AIRBNB_LEASE_TERM],
    airbnbRentalsAllowed: true,
    entireHomeMonthlyRent: 3200,
    housePhotoDataUrls: [],
  } as typeof base;
  render(<ListingEditorV2 title="T" submission={sub} onChange={() => {}} onClose={() => {}} onPublish={onPublish} />);
  fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-review"]')!);
}

describe("publish anyway", () => {
  it("does not publish when the manager goes back", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onPublish = vi.fn(async () => true);
    mount(onPublish);
    fireEvent.click(screen.getByRole("button", { name: "Create property" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("No photos yet."));
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("publishes after one yes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onPublish = vi.fn(async () => true);
    mount(onPublish);
    fireEvent.click(screen.getByRole("button", { name: "Create property" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(LISTING_V2_STEPS.length).toBeGreaterThan(0);
  });
});
