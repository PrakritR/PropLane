// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: () => undefined,
    getRoomOptionsForProperty: (propertyId: string) => (propertyId === "prop-a" ? [{ value: "prop-a::room-1", label: "Room 1" }, { value: "prop-a::room-2", label: "Room 2" }] : []),
  };
});

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
});
afterEach(() => { cleanup(); localStorage.clear(); clearAllWorkspaceDrafts(); });

import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { BookingsBlockDatesModal } from "@/components/portal/bookings-block-dates-modal";
import { BookingsCancelDialog } from "@/components/portal/bookings-cancel-dialog";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { bookingCancelLabel, canCancelBooking, isReservedBlock } from "@/lib/channel-calendar/booking-presentation";
import { channelCheckFacts, type ChannelRoomLink } from "@/lib/channel-calendar/channel-links";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDays, dateKey } from "@/lib/room-availability-calendar";

const TODAY = new Date(2026, 8, 10);
const key = (offset: number) => dateKey(addDays(TODAY, offset));

function entry(overrides: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry {
  return { source: "block", propertyId: "prop-a", propertyLabel: "Prop A House", roomId: "room-1", roomLabel: "Room 1", summary: "Reserved", start: key(3), end: key(4), blockId: "b1", ...overrides };
}

describe("clicking an empty room-day", () => {
  it("reports the property, room and night; occupied nights and past nights are not clickable", () => {
    const onReserveRoomDay = vi.fn();
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[entry({ source: "proplane", blockId: undefined, residentName: "Jordan", start: key(1), end: key(2) })]} today={TODAY} onReserveRoomDay={onReserveRoomDay} />);
    const cell = (day: string, room: string) => document.querySelector(`[data-attr="bookings-calendar-empty-cell"][data-day="${day}"][data-room="${room}"]`) as HTMLElement | null;
    expect(cell(key(1), "room-1")).toBeNull();
    expect(cell(key(-1), "room-1")).toBeNull();
    const free = cell(key(5), "room-2")!;
    expect(free.getAttribute("aria-label")).toContain("reserved on");
    fireEvent.click(free);
    expect(onReserveRoomDay).toHaveBeenCalledWith({ propertyId: "prop-a", roomId: "room-2", dayKey: key(5) });
  });

  it("draws no clickable cells when nothing handles them", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[]} today={TODAY} />);
    expect(document.querySelector('[data-attr="bookings-calendar-empty-cell"]')).toBeNull();
  });
});

const PROPERTY_OPTIONS = [{ id: "prop-a", label: "Prop A House" }];
describe("Mark reserved modal", () => {
  const link: ChannelRoomLink = { propertyId: "prop-a", roomId: "room-2", provider: "airbnb", connectionId: "c1", lastSyncedAt: null, exportLastFetchedAt: null };
  function open(extra: Partial<React.ComponentProps<typeof BookingsBlockDatesModal>> = {}, onSave = vi.fn(() => Promise.resolve())) {
    render(
      <AppUiProvider>
        <BookingsBlockDatesModal open mode="reserve" onClose={() => {}} propertyOptions={PROPERTY_OPTIONS} initialPropertyId="prop-a" initialRoomId="room-2" initialDayKey="2026-09-20" entries={[]} onSave={onSave} {...extra} />
      </AppUiProvider>,
    );
    return onSave;
  }

  it("is titled Mark reserved, opens prefilled on the review step, and one Save writes check-in = the day, check-out = the next day", async () => {
    const onSave = open();
    expect(screen.getByText("Mark reserved")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="bookings-block-dates-save"]')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ propertyId: "prop-a", roomId: "room-2", checkIn: "2026-09-20", checkOut: "2026-09-21", residentName: "" });
  });

  it("states that Airbnb picks the change up only for a room linked to Airbnb", () => {
    open({ channelLinks: [link] });
    const fact = document.querySelector('[data-attr="bookings-block-airbnb-fact"]')!;
    expect(fact.textContent).toBe("AirbnbUpdates when Airbnb next checks PropLane");
    cleanup();
    open({ channelLinks: [{ ...link, roomId: "room-1" }] });
    expect(document.querySelector('[data-attr="bookings-block-airbnb-fact"]')).toBeNull();
  });
});

describe("removing a block", () => {
  const TODAY_KEY = "2026-09-10";
  it("a block that already started can be removed; a finished or cancelled one cannot", () => {
    expect(canCancelBooking(entry({ start: "2026-09-08", end: "2026-09-12" }), TODAY_KEY)).toBe(true);
    expect(canCancelBooking(entry({ start: "2026-09-12", end: "2026-09-14" }), TODAY_KEY)).toBe(true);
    expect(canCancelBooking(entry({ start: "2026-09-01", end: "2026-09-05" }), TODAY_KEY)).toBe(false);
    expect(canCancelBooking(entry({ bookingStatus: "cancelled" }), TODAY_KEY)).toBe(false);
  });
  it("residents (hold, lease) and channel stays are never removable here", () => {
    for (const source of ["hold", "proplane", "airbnb"] as const) {
      expect(canCancelBooking(entry({ source, blockId: source === "airbnb" ? undefined : "x", start: "2026-09-12", end: "2026-09-14" }), TODAY_KEY)).toBe(false);
    }
  });
  it("a block with nobody attached is labelled Delete reservation, one with a resident Cancel booking", () => {
    expect(isReservedBlock(entry())).toBe(true);
    expect(bookingCancelLabel(entry())).toBe("Delete reservation");
    expect(bookingCancelLabel(entry({ residentName: "Maya" }))).toBe("Cancel booking");
  });
  it("Delete asks for a destructive confirm, hard-deletes the block and offers Undo that re-saves the same row", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<AppUiProvider><BookingsCancelDialog entry={entry({ blockId: "axis_room_block_mgr-1_abc", start: dateKey(addDays(new Date(), -2)), end: dateKey(addDays(new Date(), -1)) })} viewerUserId="mgr-1" onClose={onClose} onSave={onSave} onDelete={onDelete} /></AppUiProvider>);
    expect(screen.getByText("Delete this reservation?")).toBeTruthy();
    expect(screen.getByText("Room")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Notify guest" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("axis_room_block_mgr-1_abc"));
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Undo", hidden: true }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: "axis_room_block_mgr-1_abc", roomId: "room-1", checkIn: expect.any(String), bookingStatus: "hold" });
  });
  it("a co-manager deleting the owner's reservation gets the delete but no Undo, since the route would refuse the re-insert", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<AppUiProvider><BookingsCancelDialog entry={entry({ blockId: "axis_room_block_owner-1_abc" })} viewerUserId="co-manager-1" onClose={onClose} onSave={vi.fn()} onDelete={onDelete} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("axis_room_block_owner-1_abc"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await screen.findByText("Reservation deleted.", {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo", hidden: true })).toBeNull();
  });
  it("a failed delete keeps the dialog open with the server's message", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("Calendar edit access is required."));
    const onClose = vi.fn();
    render(<AppUiProvider><BookingsCancelDialog entry={entry()} onClose={onClose} onSave={vi.fn()} onDelete={onDelete} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Calendar edit access is required."));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this reservation?")).toBeTruthy();
  });
});

describe("last-checked facts", () => {
  it("label both directions with a time, and say Not yet when a side never checked", () => {
    const now = new Date("2026-10-09T20:00:00");
    const facts = channelCheckFacts({ lastSyncedAt: new Date("2026-10-09T17:40:00").toISOString(), exportLastFetchedAt: new Date("2026-10-09T17:42:00").toISOString() }, now);
    expect(facts).toEqual([
      { label: "Airbnb checked PropLane", value: "5:42 PM" },
      { label: "PropLane checked Airbnb", value: "5:40 PM" },
    ]);
    expect(channelCheckFacts({ lastSyncedAt: null }, now)[0]!.value).toBe("Not yet");
  });
});
