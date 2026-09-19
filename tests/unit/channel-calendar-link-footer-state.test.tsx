// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
  saveChannelCalendarConnection: () => Promise.resolve({ id: "connection-1" }),
  syncChannelCalendarConnection: () => Promise.resolve(),
  deleteChannelCalendarConnection: () => Promise.resolve(),
}));

vi.mock("@/lib/rental-application/data", () => ({
  getRoomOptionsForProperty: () => [{ value: "house-1::room-1", label: "Room 1" }],
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.split("::")[1] ?? null }),
}));

import { ChannelCalendarLinkFields } from "@/components/portal/channel-calendar-link-modal";

afterEach(cleanup);

describe("ChannelCalendarLinkFields footer state", () => {
  it("uses the latest footer callback on the next state change without notifying for callback replacement", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <ChannelCalendarLinkFields
        active
        propertyIds={["house-1"]}
        propertyOptions={[{ id: "house-1", label: "House 1" }]}
        initialPropertyId="house-1"
        showToast={() => {}}
        onFooterState={first}
      />,
    );

    expect(first).toHaveBeenCalled();
    second.mockClear();
    view.rerender(
      <ChannelCalendarLinkFields
        active
        propertyIds={["house-1"]}
        propertyOptions={[{ id: "house-1", label: "House 1" }]}
        initialPropertyId="house-1"
        showToast={() => {}}
        onFooterState={second}
      />,
    );
    expect(second).not.toHaveBeenCalled();

    fireEvent.change(view.getByLabelText("Airbnb import URL"), {
      target: { value: "https://example.test/calendar.ics" },
    });
    expect(second).toHaveBeenCalledWith({
      canSave: true,
      busy: false,
      syncing: false,
      syncableCount: 0,
    });
  });
});
