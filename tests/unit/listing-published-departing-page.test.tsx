// @vitest-environment jsdom
//
// The page the publish is ISSUED from, not the one it lands on.
//
// Publishing empties the drafts bucket that page is routed by, so in the very
// same flush `routePropertyEntry` goes null and the panel's stage correction
// resolves to whichever stage MANAGER_STAGES names first ("all"). Unless the
// just-published guard is already set on this side of the navigation, that
// correction fires a SECOND `router.replace` — the manager lands on All rather
// than the Listed route the publish asked for, and an unlucky flush order can
// let the landing mount consume the marker before that second navigation
// remounts the panel with nothing left to seed the confirmation from.
//
// This drives the real chain: the wizard's `onPublished` → the panel body's
// draft handler → `announcePublished` → the guard the stage correction reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const LISTING_ID = "mgr-142-test-ave";
const DRAFT_DETAIL_PATH = `/portal/properties/drafts/${LISTING_ID}/preview`;
const LISTED_DETAIL_HREF = `/portal/properties/listed/${LISTING_ID}/preview`;

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => DRAFT_DETAIL_PATH,
  // `?edit=1` is the detail page's own "resume this draft" entry point, so the
  // wizard opens without having to walk the ⋯ menu.
  useSearchParams: () => new URLSearchParams("edit=1"),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", ready: true }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
  resolveManagerScopeUserId: (id: string | null) => id,
}));

/** Flips the moment the wizard reports a publish, exactly as the real helper does. */
let published = false;

const row = {
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
  // Bucket 5 is Drafts, bucket 2 is Listed. Publishing moves the row across.
  readAdminPropertyRows: (bucket: number) => {
    if (bucket === 5) return published ? [] : [row];
    if (bucket === 2) return published ? [row] : [];
    return [];
  },
}));

// The wizard itself is not under test — only what the panel does with the id it
// reports back. This stands in for "the manager pressed Publish".
vi.mock("@/components/portal/listing-wizard-v2", () => ({
  ListingWizardV2: ({ onPublished }: { onPublished?: (id?: string) => void }) => (
    <button
      type="button"
      onClick={() => {
        published = true;
        onPublished?.(LISTING_ID);
      }}
    >
      Fake publish
    </button>
  ),
}));
vi.mock("@/components/portal/listing-wizard-v2/wizard-overlay", () => ({
  ListingWizardOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// The draft detail page mounts the prospect-facing preview, which reaches for a
// browser Supabase client this test has no credentials for and no use for.
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => null }));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerHousePropertiesPanel } from "@/components/portal/pro-house-properties-panel";
import { peekJustPublishedListing } from "@/lib/manager-listing-just-published";

function mockDesktopMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

function renderDraftDetail() {
  return render(
    <AppUiProvider>
      <ManagerHousePropertiesPanel
        showToast={() => {}}
        activeStage="drafts"
        onStageChange={() => {}}
        skuTier="starter"
        skuLoaded
        propertiesBase="/portal"
        propertyKey={LISTING_ID}
        detailTab="preview"
      />
    </AppUiProvider>,
  );
}

/** Every stage-detail route `replace` was asked for, publish navigation aside. */
const stageRedirects = () =>
  replace.mock.calls
    .map((call) => String(call[0]))
    .filter((href) => href !== LISTED_DETAIL_HREF && href !== DRAFT_DETAIL_PATH);

beforeEach(() => {
  published = false;
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

describe("publishing a draft from its own detail page", () => {
  it("navigates to the Listed route and issues no competing stage redirect", async () => {
    renderDraftDetail();
    const publishButton = await screen.findByRole("button", { name: "Fake publish" });

    fireEvent.click(publishButton);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(LISTED_DETAIL_HREF, { scroll: false }));
    // The record has left the drafts bucket this page is routed by, so the
    // stage correction has resolved — and must have stood down.
    expect(stageRedirects()).toEqual([]);
  });

  it("leaves the confirmation in storage for the page it is navigating to", async () => {
    renderDraftDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Fake publish" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(LISTED_DETAIL_HREF, { scroll: false }));
    expect(peekJustPublishedListing(LISTING_ID)).toEqual({ id: LISTING_ID, name: "142 Test Ave" });
  });

  it("keeps standing down while the flush settles, not just for one render", async () => {
    renderDraftDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Fake publish" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(LISTED_DETAIL_HREF, { scroll: false }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stageRedirects()).toEqual([]);
  });
});
