// @vitest-environment jsdom
//
// PRP-496 — publishing shows a confirmation dialog instead of navigating
// straight to the listing detail route. This pins the dialog's own contract:
// it names the listing, shows the public link, and offers exactly the three
// actions its call sites wire up (View listing / Share / Back to
// properties), with the header ✕ behaving as Back to properties.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ListingPublishedDialog } from "@/components/portal/listing-wizard-v2/listing-published-dialog";

/** Desktop dialog, not the phone drawer, so the assertions walk a stable DOM shape. */
function mockDesktopMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ListingPublishedDialog", () => {
  it("names the listing, shows its public link, and offers the three actions", () => {
    mockDesktopMatchMedia();
    render(
      <ListingPublishedDialog
        open
        name="142 Test Ave"
        listingId="mgr-142-test-ave"
        onViewListing={() => {}}
        onBackToProperties={() => {}}
      />,
    );
    expect(screen.getByText("Listing published")).toBeTruthy();
    expect(screen.getByText("142 Test Ave")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByDisplayValue(/\/rent\/listings\/mgr-142-test-ave$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "View listing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to properties" })).toBeTruthy();
  });

  it("omits the Zillow feed line unless the caller explicitly says it is included", () => {
    mockDesktopMatchMedia();
    render(
      <ListingPublishedDialog
        open
        name="Home"
        listingId="mgr-1"
        onViewListing={() => {}}
        onBackToProperties={() => {}}
      />,
    );
    expect(screen.queryByText("Zillow feed")).toBeNull();
  });

  it("shows the Zillow feed line only when the caller says it is included", () => {
    mockDesktopMatchMedia();
    render(
      <ListingPublishedDialog
        open
        name="Home"
        listingId="mgr-1"
        zillowIncluded
        onViewListing={() => {}}
        onBackToProperties={() => {}}
      />,
    );
    expect(screen.getByText("Zillow feed")).toBeTruthy();
    expect(screen.getByText("Included")).toBeTruthy();
  });

  it("View listing runs the caller's push to the preview route", () => {
    mockDesktopMatchMedia();
    const onViewListing = vi.fn();
    render(
      <ListingPublishedDialog
        open
        name="Home"
        listingId="mgr-1"
        onViewListing={onViewListing}
        onBackToProperties={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View listing" }));
    expect(onViewListing).toHaveBeenCalledTimes(1);
  });

  it("Back to properties runs the caller's push to the list", () => {
    mockDesktopMatchMedia();
    const onBackToProperties = vi.fn();
    render(
      <ListingPublishedDialog
        open
        name="Home"
        listingId="mgr-1"
        onViewListing={() => {}}
        onBackToProperties={onBackToProperties}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to properties" }));
    expect(onBackToProperties).toHaveBeenCalledTimes(1);
  });

  it("the header ✕ behaves like Back to properties", () => {
    mockDesktopMatchMedia();
    const onBackToProperties = vi.fn();
    render(
      <ListingPublishedDialog
        open
        name="Home"
        listingId="mgr-1"
        onViewListing={() => {}}
        onBackToProperties={onBackToProperties}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close"));
    // The header ✕ is a Radix `Dialog.Close`, which fires both the button's own
    // onClick and the resulting onOpenChange(false) — same call, twice, which
    // every PortalDialog consumer already tolerates (`onClose` is idempotent
    // here). The assertion is that it fires at all, not an exact count.
    expect(onBackToProperties).toHaveBeenCalled();
  });

  it("Share opens the caller's own share sheet when page context is available", () => {
    mockDesktopMatchMedia();
    const onShare = vi.fn();
    render(
      <ListingPublishedDialog
        open
        name="Home"
        listingId="mgr-1"
        onViewListing={() => {}}
        onBackToProperties={() => {}}
        onShare={onShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it("without page context, Share copies the public link and reports through the caller's toast", async () => {
    mockDesktopMatchMedia();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const showToast = vi.fn();
    render(
      <ListingPublishedDialog
        open
        name="Home"
        listingId="mgr-1"
        onViewListing={() => {}}
        onBackToProperties={() => {}}
        showToast={showToast}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/rent/listings/mgr-1")));
    expect(showToast).toHaveBeenCalledWith("Listing link copied.");
  });
});
