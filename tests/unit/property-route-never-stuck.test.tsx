/** @vitest-environment jsdom */
// A property route must never sit on its grey skeleton forever (captain, Oct 3: "the whole property area shows
// only skeleton bars and never renders, while the left nav renders").
//
// Two ways to wedge it, both reproduced here:
//   1. The record sits in a different stage than the URL names (published, unlisted, an old tab link). The
//      panel used to hold the skeleton until its `router.replace` to the right stage landed; a replace that is
//      dropped or superseded by a navigation racing it (a tab click) left the skeleton up with no bound at all,
//      because the 20 s sync bound only covers the "portfolio still loading" branch.
//   2. The property-records request never settles. It runs inside a coalesced refresher whose in-flight slot
//      is held until the fetch settles, so every later forced sync (the panel's, the parent's, "Try again")
//      queued behind it and none ever resolved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  demo: true,
  /** bucket -> rows the local store currently holds */
  buckets: {} as Record<number, Array<Record<string, unknown>>>,
}));

const LISTING_ID = "mgr-magnolia";
const row = {
  adminRefId: LISTING_ID,
  listingId: LISTING_ID,
  buildingName: "Magnolia House",
  unitLabel: "5 rooms",
  address: "1 Main St",
  zip: "98105",
  neighborhood: "U District",
  beds: 5,
  baths: 2,
  monthlyRent: 1300,
  petFriendly: false,
  tagline: "",
  managerUserId: "mgr-1",
};

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/portal/properties/listed/${LISTING_ID}/application`,
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", ready: true }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => state.demo,
  resolveManagerScopeUserId: (id: string | null) => id,
}));
vi.mock("@/lib/demo-admin-property-inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-admin-property-inventory")>()),
  readAdminPropertyRows: (bucket: number) => state.buckets[bucket] ?? [],
}));
// The portfolio sync that never settles.
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-portfolio-access")>()),
  syncManagerPortfolioFromServer: vi.fn(() => new Promise<boolean>(() => {})),
}));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
  syncManagerApplicationsFromServer: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => null }));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerHousePropertiesPanel, PORTFOLIO_SYNC_SETTLE_MS } from "@/components/portal/pro-house-properties-panel";
import { PROPERTY_PIPELINE_FETCH_TIMEOUT_MS, syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";

function renderRoute(activeStage: "listed" | "all" = "listed") {
  return render(
    <AppUiProvider>
      <ManagerHousePropertiesPanel
        showToast={() => {}}
        activeStage={activeStage}
        onStageChange={() => {}}
        skuTier="starter"
        skuLoaded
        propertiesBase="/portal"
        propertyKey={LISTING_ID}
        detailTab="application"
      />
    </AppUiProvider>,
  );
}

const skeleton = () => document.querySelector('[data-slot="list-skeleton"]');
const detailBack = () => document.querySelector('[data-attr="property-detail-back"]');

beforeEach(() => {
  state.demo = true;
  state.buckets = {};
  replace.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a record in a different stage than the URL", () => {
  it("renders where it really sits even when the stage-correcting router.replace never lands", async () => {
    // The URL says Listed (bucket 2); the record is unlisted (bucket 3). `replace` is a mock that does nothing,
    // exactly like a navigation that was superseded by a racing tab click.
    state.buckets = { 3: [row] };
    renderRoute("listed");

    await screen.findByText("Magnolia House", {}, { timeout: 3000 }).catch(() => undefined);
    expect(detailBack()).not.toBeNull();
    expect(skeleton()).toBeNull();
    // The URL is still tidied, just not waited on.
    expect(replace).toHaveBeenCalledWith(`/portal/properties/all/${LISTING_ID}/application`, { scroll: false });
  });
});

describe("a portfolio sync that never settles", () => {
  it("renders cached data immediately and does not wait for the sync", () => {
    state.demo = false;
    state.buckets = { 2: [row] };
    renderRoute("listed");
    expect(detailBack()).not.toBeNull();
    expect(skeleton()).toBeNull();
  });

  it("ends in 'could not load' after the bound, never a forever skeleton", async () => {
    vi.useFakeTimers();
    state.demo = false;
    state.buckets = {};
    renderRoute("listed");
    expect(skeleton()).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PORTFOLIO_SYNC_SETTLE_MS + 50);
    });
    expect(skeleton()).toBeNull();
    expect(screen.getByText(/Could not load your properties/)).toBeTruthy();
  });
});

describe("the property-records request itself", () => {
  it("is bounded: a request that never answers settles false, and the next forced sync is not stuck behind it", async () => {
    vi.useFakeTimers();
    state.demo = false;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          // Hangs until aborted — a dev server that is recompiling, or a stalled connection.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    const first = syncPropertyPipelineFromServer({ force: true, userId: "mgr-hang" });
    // A second forced caller joins the queued follow-up behind the hung request.
    const second = syncPropertyPipelineFromServer({ force: true, userId: "mgr-hang" });
    await vi.advanceTimersByTimeAsync(PROPERTY_PIPELINE_FETCH_TIMEOUT_MS + 50);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(calls).toBe(2);
  });
});
