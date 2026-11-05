// @vitest-environment jsdom
/**
 * Bookings' Integrations header navigates to Settings. The empty Upcoming
 * list separately opens the retained Connect a channel popup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchChannelCalendarConnections: () => Promise.resolve([]),
  fetchManagerChannelBookings: () => Promise.resolve([]),
  fetchWritableChannelCalendarPropertyIds: (ids: string[]) => Promise.resolve(ids),
  fetchOccupancySnapshot: () => Promise.resolve({ days: [] }),
  saveManagerChannelCalendarLink: () => Promise.resolve({ ok: true }),
  saveChannelCalendarConnection: () => Promise.resolve({ id: "c1" }),
  syncChannelCalendarConnection: () => Promise.resolve(),
  deleteChannelCalendarConnection: () => Promise.resolve(),
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => true,
  readLeasePipeline: () => [],
  syncLeasePipelineFromServer: () => Promise.resolve([]),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  syncPropertyPipelineFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => null,
  isEntireHomeProperty: () => false,
  parseRoomChoiceValue: () => ({ listingRoomId: null }),
  getRoomOptionsForProperty: () => [],
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: null, ready: true }),
}));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  MANAGER_PORTFOLIO_REFRESH_EVENTS: [] as const,
  buildManagerPropertyFilterOptions: () => [{ id: "mgr-house-1", label: "Ash Flats 6" }],
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerBookings } from "@/components/portal/pro-bookings";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ settings: {} }) } as Response),
    ),
  );
}

const originalUrl = window.location.href;
beforeEach(() => {
  window.history.replaceState({}, "", "/portal/bookings");
  navigate.mockClear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", originalUrl);
});

describe("Bookings calendar connections", () => {
  it("the Calendar header navigates to Integrations without opening a popup", async () => {
    const view = render(
      <AppUiProvider>
        <ManagerBookings bucket="calendar" basePath="/portal" />
      </AppUiProvider>,
    );
    const integrations = await screen.findByRole("button", { name: "Integrations" });
    const target = "/portal/profile?tab=spreadsheets&integration=bookings";
    expect(integrations).toHaveAttribute("data-attr", "bookings-integrations");
    expect(integrations).toHaveAttribute("data-integrations-target", target);
    expect(view.container.querySelector('[data-attr="portfolio-bookings-link-airbnb"]')).toBeNull();

    fireEvent.click(integrations);

    expect(navigate).toHaveBeenCalledExactlyOnceWith(target);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.querySelector('[data-attr="channel-calendar-link-modal"]')).toBeNull();
  });

  it("the empty Upcoming list opens the one-page Connect a channel popup", async () => {
    render(
      <AppUiProvider>
        <ManagerBookings bucket="upcoming" basePath="/portal" />
      </AppUiProvider>,
    );
    const linkCalendars = await screen.findByRole("button", { name: "Link calendars" });
    expect(linkCalendars).toHaveAttribute("data-attr", "bookings-empty-link-airbnb");
    await waitFor(() => expect(linkCalendars).toBeEnabled());
    fireEvent.click(linkCalendars);

    expect(await screen.findByRole("dialog", { name: "Connect a channel" })).toBeTruthy();
    expect(document.body.querySelector('[data-attr="channel-calendar-link-provider"]')).not.toBeNull();
    expect(document.body.querySelector('[data-attr="channel-calendar-link-scope"]')).toBeNull();
    expect(document.body.querySelector('[data-attr="bookings-sheet-pane-block"]')).toBeNull();
    expect(document.body.querySelector('[data-attr="bookings-sheet-pane-airbnb"]')).toBeNull();
    expect(document.body.querySelector('[data-attr="channel-calendar-link-modal"]')).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps Filter on the command bar with one property", async () => {
    const view = render(
      <AppUiProvider>
        <ManagerBookings bucket="upcoming" basePath="/portal" />
      </AppUiProvider>,
    );
    await waitFor(() =>
      expect(view.container.querySelector('[data-attr="bookings-filter-sheet-open"]')).not.toBeNull(),
    );
  });
});
