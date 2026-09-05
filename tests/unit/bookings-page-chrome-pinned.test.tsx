// @vitest-environment jsdom
/**
 * The Bookings tabs + action row must be PINNED page chrome, not rows in the
 * scroller.
 *
 * `partitionPortalPageChildren` splits chrome from body by inspecting the page
 * shell's OWN children, and React cannot see through a component boundary — so
 * a page that hands the shell one wrapper component puts its whole header
 * inside `PortalPageScrollBody` and the tabs, Filter, Settings and Link Airbnb
 * scroll away with the bookings.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

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
}));
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => () => {},
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: null, ready: true }),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  MANAGER_PORTFOLIO_REFRESH_EVENTS: [] as const,
  buildManagerPropertyFilterOptions: () => [
    { id: "mgr-house-1", label: "4709A 8th Ave NE" },
    { id: "mgr-house-2", label: "Ash Flats 6" },
  ],
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerBookings } from "@/components/portal/pro-bookings";
import { PORTAL_PAGE_SCROLL_BODY_CLASS } from "@/lib/portal-page-chrome-layout";

async function renderBookings() {
  const view = render(
    <AppUiProvider>
      <ManagerBookings bucket="upcoming" basePath="/portal" />
    </AppUiProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

describe("Bookings page chrome stays pinned while the list scrolls", () => {
  it("keeps the tabs and the action row OUT of the scrolling body", async () => {
    const view = await renderBookings();

    const scroller = view.container.querySelector(`.${PORTAL_PAGE_SCROLL_BODY_CLASS}`);
    expect(scroller).not.toBeNull();

    const tabs = view.container.querySelector("[data-portal-list-destination-nav]");
    const actions = view.container.querySelector('[data-attr="portal-list-command-actions"]');
    expect(tabs).not.toBeNull();
    expect(actions).not.toBeNull();

    // The whole point: neither may be a descendant of the scroller.
    expect(scroller!.contains(tabs!)).toBe(false);
    expect(scroller!.contains(actions!)).toBe(false);
  });

  it("puts the bookings list itself INSIDE the scrolling body", async () => {
    const view = await renderBookings();
    const scroller = view.container.querySelector(`.${PORTAL_PAGE_SCROLL_BODY_CLASS}`)!;
    const list = view.container.querySelector('[data-attr="bookings-list-panel"]');
    expect(list).not.toBeNull();
    expect(scroller.contains(list!)).toBe(true);
  });

  it("renders the Link Airbnb and Settings controls in that pinned row", async () => {
    const view = await renderBookings();
    const actions = view.container.querySelector('[data-attr="portal-list-command-actions"]')!;
    expect(actions.querySelector('[data-attr="portfolio-bookings-link-airbnb"]')).not.toBeNull();
    expect(actions.querySelector('[data-attr="bookings-settings-open"]')).not.toBeNull();
  });
});
