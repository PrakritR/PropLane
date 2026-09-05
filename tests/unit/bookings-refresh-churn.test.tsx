// @vitest-environment jsdom
/**
 * A portfolio refresh event must not blank the bookings list back to skeletons.
 *
 * `buildManagerPropertyFilterOptions` returns a FRESH array on every call, and
 * the Bookings page recalls it on every `MANAGER_PORTFOLIO_REFRESH_EVENTS`
 * event. Keying the Airbnb fetch on that array's identity meant an unrelated
 * event — a pipeline sync, a `storage` write from another tab — refetched the
 * same bookings and flashed grey placeholders over rows the manager was
 * reading.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const fetchBookings = vi.fn(() => Promise.resolve([]));

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: (...args: unknown[]) => fetchBookings(...(args as [])),
  saveManagerChannelCalendarLink: () => Promise.resolve({ ok: true }),
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  readLeasePipeline: () => [],
  syncLeasePipelineFromServer: () => Promise.resolve([]),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  syncPropertyPipelineFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => null,
  isEntireHomeProperty: () => false,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: null, ready: true }),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  MANAGER_PORTFOLIO_REFRESH_EVENTS: ["axis-property-pipeline"] as const,
  // The real builder rebuilds this array from storage on every call — same
  // houses, different array. That is the whole point of the regression.
  buildManagerPropertyFilterOptions: () => [
    { id: "mgr-house-1", label: "4709A 8th Ave NE" },
    { id: "mgr-house-2", label: "Ash Flats 6" },
  ],
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerBookings } from "@/components/portal/pro-bookings";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Bookings does not refetch when the portfolio array is merely rebuilt", () => {
  it("fetches once, and an unrelated portfolio event does not fetch again", async () => {
    fetchBookings.mockClear();
    render(
      <AppUiProvider>
        <ManagerBookings bucket="upcoming" basePath="/portal" />
      </AppUiProvider>,
    );
    await settle();
    expect(fetchBookings).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("axis-property-pipeline"));
    });
    await settle();
    await act(async () => {
      window.dispatchEvent(new Event("axis-property-pipeline"));
    });
    await settle();

    expect(fetchBookings).toHaveBeenCalledTimes(1);
  });

  it("keeps the loaded list on screen instead of re-showing skeletons", async () => {
    fetchBookings.mockClear();
    const view = render(
      <AppUiProvider>
        <ManagerBookings bucket="upcoming" basePath="/portal" />
      </AppUiProvider>,
    );
    await settle();

    // Empty state proves the first load finished; a skeleton pass would replace it.
    expect(view.container.textContent).toContain("No stays in this view");

    await act(async () => {
      window.dispatchEvent(new Event("axis-property-pipeline"));
    });
    await settle();

    expect(view.container.textContent).toContain("No stays in this view");
  });
});
