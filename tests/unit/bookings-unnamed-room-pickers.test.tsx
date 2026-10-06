// @vitest-environment jsdom
/**
 * A room the manager never named gets a Calendar row ("Room n"), so every
 * manager Bookings room picker must offer it too — otherwise the Calendar
 * shows a row its own Add booking flow cannot book. The public applicant
 * surfaces stay on the old behaviour and are covered by
 * `bookings-property-rooms.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
  fetchOccupancySnapshot: () => Promise.resolve({ days: [] }),
  saveChannelCalendarConnection: () => Promise.resolve({ id: "c1" }),
  syncChannelCalendarConnection: () => Promise.resolve(),
  deleteChannelCalendarConnection: () => Promise.resolve(),
}));

import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { BookingsBlockDatesModal } from "@/components/portal/bookings-block-dates-modal";
import { BookingsMoveRoomSheet } from "@/components/portal/bookings-move-room-sheet";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { seedDemoManagerProperties } from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import type { MockProperty } from "@/data/types";

const ID = "demo-prop-maple";

/** Maple Duplex, five rooms, the third one left unnamed. */
function seedMaple() {
  const rooms = Array.from({ length: 5 }, (_, i) => ({ ...emptyRoom(i), id: `r${i + 1}`, name: `Bedroom ${i + 1}` }));
  rooms[2] = { ...rooms[2]!, name: "   " };
  const property: MockProperty = {
    id: ID, title: "Maple Duplex", tagline: "", address: "88 Maple Ave", zip: "98107", neighborhood: "",
    beds: 2, baths: 1, rentLabel: "$1,850/mo", available: "Now", petFriendly: false,
    buildingId: ID, buildingName: "Maple Duplex", unitLabel: "",
    listingSubmission: { ...createDefaultListingSubmission(), listingPlaceCategoryId: "private_room", rooms },
  } as MockProperty;
  seedDemoManagerProperties("z-manager", [property]);
}

const entry: PropertyBookingEntry = {
  source: "block", propertyId: ID, propertyLabel: "Maple Duplex", roomId: "r3", roomLabel: "Room 3",
  summary: "Hold", start: "2099-01-01", end: "2099-01-05", blockId: "block-1", bookingStatus: "hold",
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, "", "/portal/bookings/calendar");
  seedMaple();
});

afterEach(() => {
  cleanup();
  clearAllWorkspaceDrafts();
});

/** The portal select is a trigger + portaled listbox, not a native `<select>`. */
function readOptions(dataAttr: string) {
  const trigger = document.querySelector(`[data-attr="${dataAttr}"]`) as HTMLElement;
  fireEvent.click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  return [...listbox.querySelectorAll('[role="option"]')].map((option) => ({
    value: option.getAttribute("data-field-select-option-value") ?? "",
    label: (option.textContent ?? "").replace(/^\u2713/, "").trim(),
  }));
}

describe("manager Bookings room pickers offer an unnamed room", () => {
  it("Add booking lists all five rooms, the unnamed one as 'Room 3'", () => {
    render(
      <AppUiProvider>
        <BookingsBlockDatesModal
          open
          onClose={() => {}}
          propertyOptions={[{ id: ID, label: "Maple Duplex" }]}
          initialPropertyId={ID}
          initialDayKey="2099-01-01"
          entries={[]}
          residentOptions={[]}
          onSave={async () => {}}
        />
      </AppUiProvider>,
    );
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-property"]')!);
    const options = readOptions("bookings-block-room");
    expect(options).toHaveLength(6); // "Whole home (every room)" + five rooms
    const unnamed = options.find((option) => option.label.startsWith("Room 3"));
    expect(unnamed).toBeDefined();
    expect(unnamed!.value).toContain("r3");
  });

  it("Move room offers the unnamed room and names the booking's own room in the preview", () => {
    render(
      <AppUiProvider>
        <BookingsMoveRoomSheet open onClose={() => {}} entry={entry} entries={[entry]} onSave={async () => {}} />
      </AppUiProvider>,
    );
    // The booking sits in the unnamed room: the preview names it rather than rendering blank.
    expect(document.body.textContent).toContain("Room 3");
    const options = readOptions("bookings-move-room-select");
    expect(options.map((option) => option.value)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(options[2]!.label.startsWith("Room 3")).toBe(true);
  });
});
