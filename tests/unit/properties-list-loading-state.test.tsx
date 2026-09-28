// @vitest-environment jsdom
//
// PRP-429 sibling: `/api/property-records` can run several seconds behind
// every other dashboard/list source under load. Until this fix, the
// Properties list showed the confident "No homes yet / Import your
// portfolio" empty state for that whole window — reading as an emptied
// account rather than a slow fetch. This proves the three states the fix
// distinguishes: pending (loading, never the empty copy), resolved-empty
// (the real empty state), and resolved-with-rows (the list).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerProperties } from "@/components/portal/pro-properties";
import type { AdminPropertyRow } from "@/lib/demo-admin-property-inventory";

const state = vi.hoisted(() => ({
  resolvers: [] as Array<(synced: boolean) => void>,
  listedRows: [] as AdminPropertyRow[],
}));

function resolveAllSyncs(synced: boolean) {
  const pending = state.resolvers;
  state.resolvers = [];
  pending.forEach((resolve) => resolve(synced));
}

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-loading-state-1", email: "loading-state@example.test", ready: true }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/portal/properties",
  useSearchParams: () => new URLSearchParams(),
}));
// The real fetch-backed sync is replaced with a promise this file resolves on
// demand, so the "in flight" window is something a test can actually hold
// open and inspect rather than racing a real (or instantly-resolved) fetch.
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncManagerPortfolioFromServer: () =>
    new Promise<boolean>((resolve) => {
      state.resolvers.push(resolve);
    }),
}));
// The list's rows and the empty/loading state all read this same local store.
// Only the "listed" bucket (2) is faked; every other bucket stays empty, same
// as a fresh session.
vi.mock("@/lib/demo-admin-property-inventory", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readAdminPropertyRows: (bucket: number): AdminPropertyRow[] => (bucket === 2 ? state.listedRows : []),
  };
});

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/manager/subscription")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tier: null, effectiveTier: "starter", propertyLimit: null, accountLinkLimit: null, planUnknown: false }),
        } as unknown as Response;
      }
      if (href.includes("/api/pro/account-links")) {
        return { ok: true, status: 200, json: async () => ({ invites: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
    }),
  );
}

function fakeListedRow(): AdminPropertyRow {
  return {
    adminRefId: "mgr-loading-house-1",
    buildingName: "Test Loading House",
    unitLabel: "",
    address: "123 Loading St",
    zip: "98105",
    neighborhood: "Test",
    beds: 3,
    baths: 2,
    monthlyRent: 1200,
    petFriendly: false,
    tagline: "",
    listingId: "mgr-loading-house-1",
    managerUserId: "mgr-loading-state-1",
  };
}

function renderProperties() {
  // isDemoModeActive() treats "/" as the public demo surface — set a real
  // portal path so this exercises the authenticated, server-synced path the
  // bug is actually in, not the demo branch (which never awaits a sync).
  window.history.replaceState(null, "", "/portal/properties/all");
  return render(
    <AppUiProvider>
      <div className="portal-shell">
        <ManagerProperties stage="all" />
      </div>
    </AppUiProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.resolvers = [];
  state.listedRows = [];
});

describe("Properties list loading state (PRP-429 sibling)", () => {
  it("shows the loading treatment while the first sync is in flight, never the empty state", async () => {
    stubFetch();
    renderProperties();

    expect(await screen.findByRole("status", { name: "Loading records" })).toBeInTheDocument();
    expect(screen.queryByText("No homes yet")).not.toBeInTheDocument();
  });

  it("shows the real empty state once the sync resolves with no rows", async () => {
    stubFetch();
    renderProperties();
    await screen.findByRole("status", { name: "Loading records" });

    await act(async () => {
      resolveAllSyncs(true);
    });

    await waitFor(() => expect(screen.getByText("No homes yet")).toBeInTheDocument());
    expect(screen.queryByRole("status", { name: "Loading records" })).not.toBeInTheDocument();
  });

  it("shows the rows once the sync resolves with cached properties", async () => {
    // Nothing cached yet at mount — the row only lands in the local store
    // together with the sync resolving, exactly like the real
    // `syncManagerPortfolioFromServer` write-then-resolve.
    stubFetch();
    renderProperties();
    await screen.findByRole("status", { name: "Loading records" });

    await act(async () => {
      state.listedRows = [fakeListedRow()];
      resolveAllSyncs(true);
    });

    await waitFor(() => expect(screen.getByText("Test Loading House")).toBeInTheDocument());
    expect(screen.queryByRole("status", { name: "Loading records" })).not.toBeInTheDocument();
    expect(screen.queryByText("No homes yet")).not.toBeInTheDocument();
  });
});
