// @vitest-environment jsdom
//
// PRP-496: the publish confirmation could never reach the manager on the
// draft → live path.
//
// Publishing removes the record from the Drafts bucket, so the detail page the
// wizard was finished on stops being that record's URL and the panel navigates
// to the Listed detail route. `[stage]` is a dynamic segment (the same
// invariant `writePendingFirstListingAutoOpen` documents), so that navigation
// remounts `ManagerHousePropertiesPanel` and any dialog state it was holding
// dies with it. The confirmation therefore travels as a one-shot marker and is
// taken by the mount that lands on the published listing.
//
// These render the real panel rather than reading its source, so a dialog that
// is mis-wired, never opened, or shown twice fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/portal/properties/listed/mgr-142-test-ave/preview",
  useSearchParams: () => new URLSearchParams(),
}));
// The panel body is irrelevant here — this is about the dialog surviving the
// route change — so auth stays unresolved and the body renders its own
// placeholder. The dialog is a sibling of the body, which is the whole point.
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: null, ready: false }),
}));

import { ManagerHousePropertiesPanel } from "@/components/portal/pro-house-properties-panel";
import {
  clearJustPublishedListing,
  JUST_PUBLISHED_TTL_MS,
  peekJustPublishedListing,
  takeJustPublishedListing,
  writeJustPublishedListing,
} from "@/lib/manager-listing-just-published";

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

const LISTING_ID = "mgr-142-test-ave";

function renderPanel(overrides: Partial<Parameters<typeof ManagerHousePropertiesPanel>[0]> = {}) {
  return render(
    <ManagerHousePropertiesPanel
      showToast={() => {}}
      activeStage="listed"
      onStageChange={() => {}}
      skuTier="starter"
      skuLoaded
      propertiesBase="/portal"
      propertyKey={LISTING_ID}
      detailTab="preview"
      {...overrides}
    />,
  );
}

beforeEach(() => {
  replace.mockReset();
  push.mockReset();
  window.sessionStorage.clear();
  mockDesktopMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the publish confirmation is handed across the stage remount", () => {
  it("renders on the listing the marker names, with all three actions", async () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    renderPanel();

    await waitFor(() => expect(screen.getByText("Listing published")).toBeTruthy());
    expect(screen.getByText("142 Test Ave")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View listing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to properties" })).toBeTruthy();
  });

  it("consumes the marker, so remounting (or reloading) never shows it twice", async () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    const first = renderPanel();
    await waitFor(() => expect(screen.getByText("Listing published")).toBeTruthy());
    expect(peekJustPublishedListing(LISTING_ID)).toBeNull();

    first.unmount();
    renderPanel();
    await waitFor(() => expect(screen.queryByText("Listing published")).toBeNull());
  });

  it("stays silent on a property the marker does not name", async () => {
    writeJustPublishedListing({ id: "mgr-some-other-home", name: "Other home" });
    renderPanel();

    await waitFor(() => expect(screen.queryByText("Listing published")).toBeNull());
  });

  it("View listing just closes it — the navigation already happened", async () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Listing published")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "View listing" }));

    await waitFor(() => expect(screen.queryByText("Listing published")).toBeNull());
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("Back to properties closes it and goes to the Listed list", async () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Listing published")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Back to properties" }));

    await waitFor(() => expect(screen.queryByText("Listing published")).toBeNull());
    expect(push).toHaveBeenCalledWith("/portal/properties/listed", { scroll: false });
  });

  it("Share hands the listing to the page's own share sheet", async () => {
    const onSendToProspect = vi.fn();
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    renderPanel({ onSendToProspect });
    await waitFor(() => expect(screen.getByText("Listing published")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(onSendToProspect).toHaveBeenCalledWith(LISTING_ID);
    await waitFor(() => expect(screen.queryByText("Listing published")).toBeNull());
  });
});

describe("the stage correction the confirmation suppresses", () => {
  /**
   * The body only redirects when the routed property is not in the URL's stage
   * but IS somewhere else, so the marker's suppression can only be observed
   * against a panel whose portfolio really disagrees with the URL. These drive
   * the suppression through the panel's own contract: the marker is read into
   * state during the first render, and dismissing the dialog clears it.
   */
  it("hands the body a listing id while the confirmation is up, and nothing once it is dismissed", async () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Listing published")).toBeTruthy());

    // The marker left storage the moment it was read, so nothing downstream can
    // still be consulting it — the suppression now lives in React state.
    expect(peekJustPublishedListing(LISTING_ID)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View listing" }));
    await waitFor(() => expect(screen.queryByText("Listing published")).toBeNull());
    expect(peekJustPublishedListing(LISTING_ID)).toBeNull();
  });

  it("drops a pending marker on a mount that is not a property detail page", async () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });

    renderPanel({ propertyKey: undefined });

    await waitFor(() => expect(peekJustPublishedListing(LISTING_ID)).toBeNull());
    expect(screen.queryByText("Listing published")).toBeNull();
  });
});

describe("the one-shot marker itself", () => {
  it("is taken exactly once, and only by the listing it names", () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    expect(peekJustPublishedListing(LISTING_ID)).toEqual({ id: LISTING_ID, name: "142 Test Ave" });
    expect(peekJustPublishedListing("mgr-other")).toBeNull();

    expect(takeJustPublishedListing(LISTING_ID)).toEqual({ id: LISTING_ID, name: "142 Test Ave" });
    expect(takeJustPublishedListing(LISTING_ID)).toBeNull();
  });

  it("peeks without consuming, so a double render still finds it", () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });

    expect(peekJustPublishedListing(LISTING_ID)).not.toBeNull();
    expect(peekJustPublishedListing(LISTING_ID)).not.toBeNull();
    expect(takeJustPublishedListing(LISTING_ID)).not.toBeNull();
  });

  it("clears a marker a different property picked up, so it cannot fire later", () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });

    expect(takeJustPublishedListing("mgr-some-other-home")).toBeNull();
    expect(peekJustPublishedListing(LISTING_ID)).toBeNull();
  });

  it("expires, so a marker whose navigation never landed cannot fire at a later visit", () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    const stale = JSON.parse(window.sessionStorage.getItem("proplane:listing-just-published")!);
    window.sessionStorage.setItem(
      "proplane:listing-just-published",
      JSON.stringify({ ...stale, at: Date.now() - JUST_PUBLISHED_TTL_MS - 1 }),
    );

    expect(peekJustPublishedListing(LISTING_ID)).toBeNull();
    // And the expired slot is dropped rather than re-read on every render.
    expect(window.sessionStorage.getItem("proplane:listing-just-published")).toBeNull();
  });

  it("ignores a blank id and survives unreadable storage", () => {
    writeJustPublishedListing({ id: "   ", name: "Nothing" });
    expect(takeJustPublishedListing(LISTING_ID)).toBeNull();

    window.sessionStorage.setItem("proplane:listing-just-published", "not json");
    expect(peekJustPublishedListing(LISTING_ID)).toBeNull();
    expect(takeJustPublishedListing(LISTING_ID)).toBeNull();
  });

  it("clearJustPublishedListing drops whatever is pending", () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });

    clearJustPublishedListing();

    expect(peekJustPublishedListing(LISTING_ID)).toBeNull();
  });
});
