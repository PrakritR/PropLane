// @vitest-environment jsdom
/**
 * Link calendars is the one dialog Bookings' header opens.
 *
 * Both controls used to drive one `ChannelCalendarLinkModal`
 * (`open={linkModalOpen || settingsModalOpen}`), so the section offered two
 * buttons that led to the same dialog and had nowhere to keep a booking
 * preference. S021 (captain, 2026-09-27) later dropped the reminders-hub
 * Settings gear entirely — its reminder settings stay reachable from the
 * central Settings -> Notifications hub.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
  fetchOccupancySnapshot: () => Promise.resolve({ days: [] }),
  saveManagerChannelCalendarLink: () => Promise.resolve({ ok: true }),
  saveChannelCalendarConnection: () => Promise.resolve({ id: "c1" }),
  syncChannelCalendarConnection: () => Promise.resolve(),
  deleteChannelCalendarConnection: () => Promise.resolve(),
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
  parseRoomChoiceValue: () => ({ listingRoomId: null }),
  getRoomOptionsForProperty: () => [],
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ settings: {} }) } as Response),
    ),
  );
}

describe("Bookings → Settings", () => {
  it("Link calendars still opens the Link calendars dialog", async () => {
    stubFetch();
    const view = render(
      <AppUiProvider>
        <ManagerBookings bucket="upcoming" basePath="/portal" />
      </AppUiProvider>,
    );
    await settle();

    fireEvent.click(view.container.querySelector('[data-attr="portfolio-bookings-link-airbnb"]')!);
    await settle();

    expect(document.body.textContent ?? "").toContain("Link calendars");
    expect(document.body.querySelector('[data-attr="bookings-sheet-pane-block"]')).toBeNull();
    expect(document.body.querySelector('[data-attr="bookings-sheet-pane-airbnb"]')).toBeNull();
    expect(document.body.querySelector('[data-attr="channel-calendar-link-modal"]')).not.toBeNull();
  });

  it("keeps Filter on the command bar with one property", async () => {
    stubFetch();
    const view = render(
      <AppUiProvider>
        <ManagerBookings bucket="upcoming" basePath="/portal" />
      </AppUiProvider>,
    );
    await settle();
    expect(view.container.querySelector('[data-attr="bookings-filter-sheet-open"]')).not.toBeNull();
  });
});
