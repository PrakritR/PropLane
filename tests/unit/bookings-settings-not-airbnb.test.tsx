// @vitest-environment jsdom
/**
 * Settings on Bookings is the SECTION's settings, not a second Link Airbnb button.
 *
 * Both controls used to drive one `ChannelCalendarLinkModal`
 * (`open={linkModalOpen || settingsModalOpen}`), so the section offered two
 * buttons that led to the same dialog and had nowhere to keep a booking
 * preference.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
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
  it("does NOT open the Link Airbnb dialog", async () => {
    stubFetch();
    const view = await (async () => {
      const v = render(
        <AppUiProvider>
          <ManagerBookings bucket="upcoming" basePath="/portal" />
        </AppUiProvider>,
      );
      await settle();
      return v;
    })();

    fireEvent.click(view.container.querySelector('[data-attr="bookings-settings-open"]')!);
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Airbnb import URL");
    expect(text).not.toContain("paste the Airbnb export URL");
    expect(text).toContain("Bookings settings");
  });

  it("Link Airbnb still opens the Link Airbnb dialog", async () => {
    stubFetch();
    const view = render(
      <AppUiProvider>
        <ManagerBookings bucket="upcoming" basePath="/portal" />
      </AppUiProvider>,
    );
    await settle();

    fireEvent.click(view.container.querySelector('[data-attr="portfolio-bookings-link-airbnb"]')!);
    await settle();

    expect(document.body.textContent ?? "").toContain("Link Airbnb");
  });
});
