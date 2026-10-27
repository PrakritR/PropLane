// @vitest-environment jsdom
//
// EVIDENCE HARNESS — bookings across channels (studio plan bookings-channels-1026), rendered for a reviewer
// screenshot: the portfolio timeline drawing an Airbnb-linked guest, a Booking.com hold and a PadSplit stay in
// their own colours (with a hatched long closure, a clash dot and a "no end" tag), the Connect Airbnb pop-up with
// Copy all PropLane links and Paste many, the Bookings integration rows (PadSplit manual), the Posting tab's
// SpareRoom Copy post row, and the reservation picker that links one stay to one channel reservation.
// Set EVIDENCE_DIR to write each surface's HTML next to the generated app.css.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { writeEvidenceSurface } from "../helpers/evidence-dom";

const toast = vi.hoisted(() => vi.fn());
const copied = vi.hoisted(() => vi.fn(async (_text: string) => true));
const data = vi.hoisted(() => ({
  rooms: {} as Record<string, { value: string; label: string }[]>,
  listings: {} as Record<string, unknown>,
}));
const channel = vi.hoisted(() => ({ rooms: [] as unknown[] }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: toast }),
}));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => {
    const active = { id: "w1", name: "Seattle", owned: true, canManageMembers: true, propertyIds: ["p1", "p2"], propertyLabels: { p1: "4709A", p2: "Maple" } };
    return { workspaces: [active], active };
  },
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: (id: string) => data.listings[id],
  getRoomOptionsForProperty: (id: string) => data.rooms[id] ?? [],
  isEntireHomeProperty: () => false,
}));
vi.mock("@/lib/manager-property-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-links")>()),
  copyTextToClipboard: copied,
}));
vi.mock("@/lib/channel-calendar/client", () => ({
  fetchChannelCalendarConnections: vi.fn(async () => []),
  fetchManagerChannelBookings: vi.fn(async () => [{ propertyId: "p1", propertyLabel: "4709A", rooms: channel.rooms }]),
  fetchOccupancySnapshot: vi.fn(async () => ({ days: [] })),
  fetchRoomExportCalendarUrl: vi.fn(async () => "https://proplane.ai/api/calendar/export/token.ics"),
  fetchWritableChannelCalendarPropertyIds: vi.fn(async (ids: string[]) => ids),
  saveChannelCalendarConnectionsBatch: vi.fn(async (items: Array<{ roomId: string; importUrl?: string | null }>) =>
    items.map((item) => ({ ok: true as const, connection: { id: `c-${item.roomId}`, hasImportUrl: Boolean(item.importUrl) } })),
  ),
  deleteChannelCalendarConnection: vi.fn(),
  syncChannelCalendarConnection: vi.fn(async () => ({})),
  syncAllChannelCalendarConnections: vi.fn(),
}));

import { BookingsCalendarLegend, BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { BookingChannelLinkField } from "@/components/portal/booking-channel-link-field";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { ManagerBookingChannelsPanel } from "@/components/portal/integrations-bookings-panel";
import { ManagerPostingPanel } from "@/components/portal/integrations-posting-panel";
import { resetSharedGets } from "@/lib/shared-get-cache";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const TODAY = new Date(2026, 8, 10);

/** A pop-up asks the viewport which presentation it is; jsdom answers "no" to everything, which is the phone answer. */
function desktopViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine") || query.includes("min-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
}

function entry(over: Partial<PropertyBookingEntry>): PropertyBookingEntry {
  return { source: "block", propertyId: "prop-a", propertyLabel: "4709A 8th Ave NE", roomId: "room-1", roomLabel: "Room 1", summary: "Alex", start: "2026-09-12", end: "2026-09-15", ...over };
}

beforeEach(() => {
  data.rooms = {
    "prop-a": [
      { value: "prop-a::room-1", label: "Room 1" },
      { value: "prop-a::room-2", label: "Room 2" },
      { value: "prop-a::room-3", label: "Room 3" },
    ],
    p1: [{ value: "p1::room-2", label: "Room 2" }, { value: "p1::room-3", label: "Room 3" }],
    p2: [{ value: "p2::room-9", label: "Room 9" }],
  };
  data.listings = { p1: { id: "p1", listingSubmission: { syndication: { zillow: { enabled: true } } } }, p2: { id: "p2", listingSubmission: {} } };
  channel.rooms = [];
  window.history.replaceState(null, "", "/portal/profile?tab=spreadsheets");
  resetSharedGets();
  desktopViewport();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("evidence: the bookings timeline across channels", () => {
  it("every channel draws in its own colour, a long closure is hatched, a double booking is dotted", () => {
    render(
      <div className="flex flex-col gap-3">
        <BookingsCalendarLegend />
        <BookingsPortfolioTimeline
          propertyIds={["prop-a"]}
          entries={[
            // Room 1: an Airbnb reservation and a Booking.com hold on the same nights — a clash.
            entry({ source: "airbnb", summary: "Reserved", sourceUid: "a1", connectionId: "c1", roomId: "room-1", start: "2026-09-12", end: "2026-09-16" }),
            entry({ source: "booking_com", summary: "CLOSED - Not available", sourceUid: "b1", connectionId: "c2", roomId: "room-1", start: "2026-09-14", end: "2026-09-18" }),
            // Room 2: a PadSplit stay, then a PropLane stay linked to its Airbnb reservation (so it keeps the guest's name).
            entry({ summary: "Jordan Pike", residentName: "Jordan Pike", blockId: "b1", stayDetails: { source: "PadSplit" }, roomId: "room-2", start: "2026-09-11", end: "2026-09-19" }),
            entry({ summary: "Kumaran Raj", residentName: "Kumaran Raj", blockId: "b2", channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" }, roomId: "room-2", start: "2026-09-21", end: "2026-09-26" }),
            // Room 2 again: a PropLane block with no end date (the "no end" tag).
            // Room 3: the host closed the room on Airbnb for a year.
            entry({ source: "airbnb", summary: "Airbnb (Not available)", start: "2026-09-02", end: "2027-10-26", sourceUid: "host", connectionId: "c3", roomId: "room-3" }),
            entry({ summary: "Blocked", residentName: undefined, openEnded: true, blockId: "b9", roomId: "room-2", start: "2026-09-28", end: "2028-09-12" }),
          ]}
          today={TODAY}
          onOpenDay={() => {}}
        />
      </div>,
    );
    const bars = Array.from(document.querySelectorAll('[data-attr="bookings-calendar-bar"]')) as HTMLElement[];
    const marks = bars.map((bar) => bar.querySelector('[role="img"]')?.getAttribute("aria-label"));
    expect(marks).toContain("Airbnb");
    expect(marks).toContain("Booking.com");
    expect(marks).toContain("PadSplit");
    expect(document.querySelectorAll('[data-attr="bookings-room-clash"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("Closed on Airbnb · until Oct 27, 2027");
    expect(document.querySelector('[data-attr="bookings-bar-no-end"]')?.textContent).toBe("no end");
    expect(document.body.textContent).toContain("Kumaran Raj");
    writeEvidenceSurface(
      "40-bookings-timeline-channels",
      "Bookings timeline: the legend names Airbnb / Booking.com / PadSplit and the hatch for a closed channel; Room 1 carries an Airbnb reservation overlapping a Booking.com hold (red clash dot by the room name), Room 2 a PadSplit stay and a PropLane stay linked to its Airbnb reservation (so it reads 'Kumaran Raj', not 'Reserved'), Room 3 a year-long hatched 'Closed on Airbnb · until Oct 27, 2027' plus a block tagged 'no end'.",
      120,
    );
  });

  it("the reservation picker links one stay to one channel reservation", () => {
    render(
      <div className="max-w-md">
        <BookingChannelLinkField
          source="Airbnb"
          entries={[
            entry({ source: "airbnb", summary: "Reserved", guestName: "Elias Mejia", reservationCode: "HMELIAS001", sourceUid: "u1", connectionId: "c1", roomId: "room-1", start: "2026-10-29", end: "2026-10-31" }),
            entry({ source: "airbnb", summary: "Reserved", reservationCode: "HMNEXT0001", sourceUid: "u2", connectionId: "c1", roomId: "room-1", start: "2026-11-02", end: "2026-11-04" }),
          ]}
          propertyId="prop-a"
          roomId="room-1"
          checkIn="2026-10-29"
          checkOut="2026-11-01"
          link={{ provider: "airbnb", reservationCode: "HMELIAS001" }}
          onChange={() => {}}
        />
      </div>,
    );
    expect(document.body.textContent).toContain("Elias Mejia");
    expect(document.body.textContent).toContain("HMELIAS001");
    writeEvidenceSurface("45-booking-channel-link-field", "Edit stay → Source: Airbnb: the reservation picker lists that room's Airbnb reservations (guest · code · dates · room) and this stay is linked to Elias Mejia's.", 160);
  });
});

describe("evidence: linking a channel calendar", () => {
  const baseProps = {
    open: true,
    initialProvider: "airbnb" as const,
    onClose: () => {},
    entries: [],
    propertyIds: ["p1", "p2"],
    propertyOptions: [{ id: "p1", label: "4709A" }, { id: "p2", label: "Maple" }],
    showToast: () => {},
  };
  const ready = () => waitFor(() => expect(document.body.textContent).not.toContain("Loading linked rooms"));

  it("the Connect Airbnb pop-up is one page: Copy all PropLane links, Paste many, a row per room", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    expect(screen.getByRole("dialog", { name: "Connect Airbnb" })).toBeTruthy();
    expect(screen.getByLabelText("Copy all PropLane links")).toBeTruthy();
    expect(screen.getByLabelText("Paste many")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr="channel-calendar-room-row"]').length).toBe(3);
    writeEvidenceSurface(
      "41-channel-link-modal",
      "Settings → Integrations → Bookings → Connect Airbnb: one page, every room of every house the manager may write calendars on, each with the channel link and its read-only PropLane export link — plus Copy all PropLane links and Paste many for a whole house at once.",
      120,
    );
  });

  it("Paste many matches links to rooms in order and flags the one that is not an Airbnb link", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    fireEvent.click(screen.getByLabelText("Paste many"));
    const links = ["https://www.airbnb.com/calendar/ical/101.ics?s=k1", "https://www.airbnb.com/calendar/ical/102.ics?s=k2", "https://evil.example.com/calendar/ical/3.ics"];
    fireEvent.change(screen.getByLabelText("Calendar links"), { target: { value: links.join("\n") } });
    fireEvent.click(screen.getByText("Match rooms"));
    const rows = Array.from(document.querySelectorAll('[data-attr="channel-calendar-paste-row"]')) as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("4709A · Room 2");
    expect(rows[1]!.textContent).toContain("4709A · Room 3");
    expect(rows[2]!.textContent).toContain("not an Airbnb calendar link");
    const use = screen.getByText(/^Use \d+ links?$/).closest("button") as HTMLButtonElement;
    expect(use.disabled || use.getAttribute("aria-disabled") === "true").toBe(true);
    writeEvidenceSurface(
      "42-channel-link-paste-many",
      "Paste many: three pasted links matched to rooms in order — the third is not an Airbnb calendar link, so it is named as such and Use stays off until it is skipped or re-pointed.",
      120,
    );
    expect(within(rows[2]!).getByRole("button", { name: /Room/ })).toBeTruthy();
  });
});

describe("evidence: the Integrations rows", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const propertyId = url.includes("/api/manager/listing-channels") ? new URL(url, "http://localhost").searchParams.get("propertyId") : null;
        const body = url.includes("/api/manager/listing-channels")
          ? {
              workspaceId: "w1",
              canManage: true,
              schemaReady: true,
              channels: [{ id: "facebook_page", availability: "coming_soon" }, { id: "instagram", availability: "coming_soon" }],
              meta: { configured: false, connected: false, pageName: null, igUsername: null, revoked: false },
              workContact: { phone: "(206) 555-0100", email: "work@example.test" },
              posts: [],
              attribution: { enabled: true, forced: false },
              listings: [
                { id: "p1", name: "4709A 8th Ave NE", roomCount: 3, status: "live", holdReasons: [] },
                { id: "p2", name: "Maple House", roomCount: 2, status: "live", holdReasons: ["no_photo"] },
              ],
              property: propertyId
                ? { id: propertyId, live: true, holdReasons: [], postTexts: { facebook_marketplace: `Room for rent…`, spareroom: `Room for rent…` } }
                : null,
            }
          : { feedUrl: "https://proplane.ai/api/feeds/zillow/abc" };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }),
    );
  });

  it("Bookings: Airbnb and Booking.com connect, PadSplit is a plain manual row, Other calendar takes any .ics", async () => {
    channel.rooms = [
      { connectionId: "airbnb-r1", roomId: "r1", roomLabel: "Room 1", provider: "airbnb", label: null, ranges: [], lastSyncedAt: "2026-10-26T18:00:00.000Z", lastError: null, hasImportUrl: true, exportUrl: "https://proplane.ai/api/calendar/export/a.ics" },
      { connectionId: "booking_com-r2", roomId: "r2", roomLabel: "Room 2", provider: "booking_com", label: null, ranges: [], lastSyncedAt: "2026-10-26T18:00:00.000Z", lastError: null, hasImportUrl: true, exportUrl: "https://proplane.ai/api/calendar/export/b.ics" },
    ];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-padsplit-status"]')?.textContent).toBe("Manual · approve each booking in PadSplit"));
    expect(document.querySelector('[data-attr="settings-airbnb-status"]')?.textContent).toContain("Connected");
    expect(document.querySelector('[data-attr="settings-ical-status"]')?.textContent).toBe("Houfy, Furnished Finder, Vrbo, any .ics");
    expect(document.body.textContent).not.toContain("SpareRoom");
    writeEvidenceSurface(
      "43-integrations-bookings-rows",
      "Settings → Integrations → Bookings: Airbnb and Booking.com linked both ways with their own room counts, PadSplit as a plain manual row (approve each booking in PadSplit, action opens the host dashboard), Vrbo Coming soon, and Other calendar for any .ics.",
      120,
    );
  });

  it("Posting: SpareRoom is a Copy post row with its own Open SpareRoom link", async () => {
    render(<ManagerPostingPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-spareroom-row"]')).not.toBeNull());
    await waitFor(() => expect((document.querySelector('[data-attr="settings-spareroom-copy-post"]') as HTMLButtonElement).disabled).toBe(false));
    expect(document.querySelector('[data-attr="settings-spareroom-open"]')?.getAttribute("aria-label")).toBe("Open SpareRoom");
    fireEvent.click(document.querySelector('[data-attr="settings-spareroom-copy-post"]') as HTMLElement);
    await waitFor(() => expect(copied).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Post copied. Paste it into SpareRoom.");
    writeEvidenceSurface(
      "44-integrations-posting-spareroom",
      "Settings → Integrations → Posting: SpareRoom sits beside Facebook Marketplace as a Copy post row — pick a listing, copy the post PropLane builds from that listing's public facts plus the work number and email, then Open SpareRoom. No API, no scrape.",
      120,
    );
  });
});
