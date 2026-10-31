// @vitest-environment jsdom
/**
 * A teammate below Calendar `edit` is not offered Unblock, Delete or Remove from PropLane, on the
 * calendar-bar popover or the booking record's header. The owner always is. docs/agents/bookings.md § Blocks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import { bookingRemovalActions } from "@/lib/channel-calendar/booking-presentation";
import { buildAllModulesGrant } from "@/lib/co-manager-permissions";
import { addDays, dateKey } from "@/lib/room-availability-calendar";

const navigate = vi.fn();
const invites = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return { ...actual, getPropertyById: () => undefined, getRoomOptionsForProperty: () => [] };
});
vi.mock("@/lib/portal-data-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-data-store")>();
  return { ...actual, readCachedAccountLinkInvites: () => invites.list };
});
vi.mock("@/lib/pro-relationships", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pro-relationships")>();
  return { ...actual, readProRelationships: () => [] };
});
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  return {
    ...actual,
    readExtraListingsForUser: (userId: string) => (userId === "owner-1" ? [{ id: "prop-a" }] : []),
    readPendingManagerPropertiesForUser: () => [],
  };
});

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";
import { canRemoveBookingEntry } from "@/lib/manager-portfolio-access";

beforeAll(() => {
  // The clock is PINNED to the same mid-month day the fixtures are built from. The timeline draws the
  // month `today` falls in, while the record page reads the real date, so a real-clock "today" near a
  // month boundary either pushed the +1/+3 day stay out of the drawn month or made it already past.
  vi.setSystemTime(NOW);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
});
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); navigate.mockClear(); localStorage.clear(); invites.list = []; });

const NOW = new Date(2026, 5, 10, 12, 0, 0);
const TODAY_KEY = dateKey(NOW);
const live: PropertyBookingEntry = { source: "block", propertyId: "prop-a", propertyLabel: "Prop A House", roomId: "room-1", roomLabel: "Room 1", summary: "Closed", start: dateKey(addDays(NOW, 1)), end: dateKey(addDays(NOW, 3)), blockId: "block-1", reason: "Closed", bookingStatus: "hold" };
const channel: PropertyBookingEntry = { ...live, source: "airbnb", blockId: undefined, bookingStatus: undefined, connectionId: "c1", sourceUid: "u1", summary: "Airbnb guest" };

function teammate(calendar: ReturnType<typeof buildAllModulesGrant>["calendar"]) {
  return {
    status: "accepted",
    direction: "incoming",
    linkedUserId: "owner-1",
    assignedPropertyIds: ["prop-a"],
    propertyCoManagerPermissions: { "prop-a": { calendar } },
  };
}

describe("canRemoveBookingEntry", () => {
  it("the owner always may", () => {
    expect(canRemoveBookingEntry("owner-1", "prop-a")).toBe(true);
  });
  it("a teammate with Calendar read only may not; edit, delete or a full grant may", () => {
    invites.list = [teammate({ read: true })];
    expect(canRemoveBookingEntry("mate-1", "prop-a")).toBe(false);
    invites.list = [teammate({ read: true, edit: true })];
    expect(canRemoveBookingEntry("mate-1", "prop-a")).toBe(true);
    invites.list = [teammate(true)];
    expect(canRemoveBookingEntry("mate-1", "prop-a")).toBe(true);
  });
  it("a teammate with no Calendar grant, or no grant on that house, may not", () => {
    invites.list = [{ ...teammate({ read: true }), propertyCoManagerPermissions: { "prop-a": { payments: true } } }];
    expect(canRemoveBookingEntry("mate-1", "prop-a")).toBe(false);
    invites.list = [teammate(true)];
    expect(canRemoveBookingEntry("mate-1", "prop-b")).toBe(false);
  });
  it("an unknown viewer is not gated (the server still refuses)", () => {
    expect(canRemoveBookingEntry(null, "prop-a")).toBe(true);
  });
});

describe("bookingRemovalActions with canRemove=false", () => {
  it("offers nothing for a native block or an imported stay", () => {
    expect(bookingRemovalActions(live, TODAY_KEY, false)).toEqual({ unblock: false, deleteBlock: false, unblockChannel: false });
    expect(bookingRemovalActions(channel, TODAY_KEY, false)).toEqual({ unblock: false, deleteBlock: false, unblockChannel: false });
    expect(bookingRemovalActions(live, TODAY_KEY)).toEqual({ unblock: true, deleteBlock: true, unblockChannel: false });
  });
});

function openBar() {
  fireEvent.keyDown(document.querySelector('[data-attr="bookings-calendar-bar"]')!, { key: "ArrowDown" });
  return document.body.querySelector('[role="menu"]')!;
}
const handlers = () => ({ onEditBooking: vi.fn(), onUnblockBooking: vi.fn(), onDeleteBlock: vi.fn(), onUnblockChannelStay: vi.fn() });

describe("calendar bar popover", () => {
  it("hides Unblock and Delete when the viewer may not remove, keeps Edit and Open booking", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[live]} today={NOW} {...handlers()} canRemoveBooking={() => false} />);
    const text = openBar().textContent ?? "";
    expect(text).not.toMatch(/Unblock|Delete/);
    expect(text).toMatch(/Edit.*Open booking/);
  });
  it("hides Unblock in PropLane on an imported bar", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[channel]} today={NOW} {...handlers()} canRemoveBooking={() => false} />);
    expect(openBar().textContent).not.toMatch(/Unblock/);
  });
  it("offers them when the viewer may", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[live]} today={NOW} {...handlers()} canRemoveBooking={() => true} />);
    expect(openBar().textContent).toMatch(/Unblock.*Delete/);
  });
  it("is asked per bar with that bar's entry", () => {
    const canRemoveBooking = vi.fn(() => false);
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[live]} today={NOW} {...handlers()} canRemoveBooking={canRemoveBooking} />);
    expect(canRemoveBooking).toHaveBeenCalledWith(live);
  });
});

const noop = async () => {};
const headerIds = () => [...document.querySelectorAll('[data-attr^="record-header-action-"]')].map((node) => node.getAttribute("data-attr")!.replace("record-header-action-", "")).sort();
function page(entry: PropertyBookingEntry, canRemoveBooking?: (entry: PropertyBookingEntry) => boolean) {
  return render(<AppUiProvider><BookingsRecordPage bookingId={bookingEntryKey(entry)} basePath="/portal" entries={[entry]} loading={false} residentOptions={[]} onSaveBlock={noop} onRemoveBlock={noop} showToast={() => {}} canRemoveBooking={canRemoveBooking} /></AppUiProvider>);
}

describe("booking record header", () => {
  it("a teammate below Calendar edit sees Edit and Message but not Unblock or Delete", () => {
    page(live, () => false);
    expect(headerIds()).toEqual(["edit", "message"]);
  });
  it("an imported stay loses Remove from PropLane", () => {
    page(channel, () => false);
    expect(headerIds()).toEqual(["edit", "message"]);
    expect(screen.queryByLabelText("Remove from PropLane")).toBeNull();
  });
  it("the owner (no gate, or a passing one) sees them all", () => {
    page(live);
    expect(headerIds()).toEqual(["delete", "edit", "message", "unblock"]);
    cleanup();
    page(live, () => true);
    expect(headerIds()).toEqual(["delete", "edit", "message", "unblock"]);
  });
});
