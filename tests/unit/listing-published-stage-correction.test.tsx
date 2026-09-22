// @vitest-environment jsdom
//
// The publish confirmation suppresses the panel's stage-correcting redirect —
// the one that sends a manager to whichever stage actually holds the record
// (PRP-429) — because racing it would land them on whichever stage
// MANAGER_STAGES names first and take the confirmation down with it.
//
// That suppression has to RELEASE. While it was read straight out of
// sessionStorage, nothing the effect depended on changed when the marker was
// consumed a moment later, so on any mount where the correction was genuinely
// needed the page stayed on "Loading this property…" forever behind the
// dialog. The decision now lives in panel state that dismissing the dialog
// clears, so the correction runs as soon as the manager is done with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/portal/properties/listed/mgr-142-test-ave/preview",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", ready: true }),
}));
// Demo mode keeps the panel's portfolio load local and synchronous — no server
// round trip to wait on before the routed property is resolved.
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
  resolveManagerScopeUserId: (id: string | null) => id,
}));

const LISTING_ID = "mgr-142-test-ave";

/**
 * The URL says Listed, the record sits in Drafts. That disagreement is the ONLY
 * state in which the stage correction fires, so it is the only state in which
 * the confirmation's suppression of it can be observed at all.
 */
const draftRow = {
  adminRefId: LISTING_ID,
  listingId: LISTING_ID,
  buildingName: "142 Test Ave",
  unitLabel: "",
  address: "142 Test Ave",
  zip: "98101",
  neighborhood: "",
  beds: 1,
  baths: 1,
  monthlyRent: 0,
  petFriendly: false,
  tagline: "",
  managerUserId: "mgr-1",
};

vi.mock("@/lib/demo-admin-property-inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-admin-property-inventory")>()),
  readAdminPropertyRows: (bucket: number) => (bucket === 5 ? [draftRow] : []),
}));

import { ManagerHousePropertiesPanel } from "@/components/portal/pro-house-properties-panel";
import { writeJustPublishedListing } from "@/lib/manager-listing-just-published";

function mockDesktopMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

function renderPanel() {
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
    />,
  );
}

const CORRECTED_HREF = "/portal/properties/all/mgr-142-test-ave/preview";

beforeEach(() => {
  replace.mockReset();
  push.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  mockDesktopMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the stage correction and the publish confirmation", () => {
  it("corrects the stage when no publish is landing", async () => {
    renderPanel();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(CORRECTED_HREF, { scroll: false }));
    expect(screen.queryByText("Listing published")).toBeNull();
  });

  it("stands down while the confirmation is up, then runs once it is dismissed", async () => {
    writeJustPublishedListing({ id: LISTING_ID, name: "142 Test Ave" });
    renderPanel();

    await waitFor(() => expect(screen.getByText("Listing published")).toBeTruthy());
    expect(replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View listing" }));

    // The suppression is released by the dismiss, not left wedged on a storage
    // key the effect never depended on.
    await waitFor(() => expect(replace).toHaveBeenCalledWith(CORRECTED_HREF, { scroll: false }));
  });

  it("is not suppressed by a marker naming some other listing", async () => {
    writeJustPublishedListing({ id: "mgr-some-other-home", name: "Other home" });
    renderPanel();

    await waitFor(() => expect(replace).toHaveBeenCalledWith(CORRECTED_HREF, { scroll: false }));
    expect(screen.queryByText("Listing published")).toBeNull();
  });
});
