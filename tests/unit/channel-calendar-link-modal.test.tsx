// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getRoomOptionsForProperty: () => [{ value: "p1::room-2", label: "Room 2" }],
  };
});

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: vi.fn(async () => []),
  fetchOccupancySnapshot: vi.fn(async () => ({ days: [] })),
  fetchRoomExportCalendarUrl: vi.fn(async () => "https://proplane.ai/api/calendar/export/token.ics"),
  saveChannelCalendarConnection: vi.fn(),
  deleteChannelCalendarConnection: vi.fn(),
  syncChannelCalendarConnection: vi.fn(),
  syncAllChannelCalendarConnections: vi.fn(),
}));

import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { fetchRoomExportCalendarUrl } from "@/lib/channel-calendar/client";

afterEach(() => cleanup());

describe("ChannelCalendarLinkModal", () => {
  it("lists Airbnb and Booking.com only and shows Link & sync in the Link card", async () => {
    render(
      <ChannelCalendarLinkModal
        open
        onClose={() => {}}
        propertyIds={["p1"]}
        propertyOptions={[{ id: "p1", label: "4709A" }]}
        showToast={() => {}}
      />,
    );
    const trigger = document.querySelector('[data-attr="channel-calendar-link-provider"]') as HTMLElement;
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(
      [...listbox.querySelectorAll("[role='option']")].map((o) => o.textContent?.replace(/^✓/, "")),
    ).toEqual(["Airbnb", "Booking.com"]);
    expect(document.querySelector('[data-attr="channel-calendar-link-import-url"]')).toBeTruthy();
    await waitFor(() => {
      expect(fetchRoomExportCalendarUrl).toHaveBeenCalled();
      expect(document.querySelector('[data-attr="channel-calendar-proplane-export"]')).toBeTruthy();
    });
    expect(screen.getByText("Link & sync")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByText("Save & sync")).toBeNull();
    expect(document.querySelector('[data-attr="channel-calendar-sync-all"]')).toBeNull();
  });

  it("does not remount into Loading linked rooms when the parent refreshes", async () => {
    const props = {
      open: true,
      onClose: () => {},
      propertyIds: ["p1"],
      propertyOptions: [{ id: "p1", label: "4709A" }],
      showToast: () => {},
    };
    const { rerender } = render(<ChannelCalendarLinkModal {...props} />);
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Loading linked rooms");
    });
    rerender(<ChannelCalendarLinkModal {...props} onChanged={() => {}} />);
    expect(document.body.textContent).not.toContain("Loading linked rooms");
  });
});
