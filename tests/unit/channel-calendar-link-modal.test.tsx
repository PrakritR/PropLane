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
  fetchChannelCalendarConnections: vi.fn(async () => []),
  fetchManagerChannelBookings: vi.fn(async () => []),
  fetchOccupancySnapshot: vi.fn(async () => ({ days: [] })),
  fetchRoomExportCalendarUrl: vi.fn(async () => "https://proplane.ai/api/calendar/export/token.ics"),
  saveChannelCalendarConnection: vi.fn(),
  deleteChannelCalendarConnection: vi.fn(),
  syncChannelCalendarConnection: vi.fn(),
  syncAllChannelCalendarConnections: vi.fn(),
}));

import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { saveChannelCalendarConnection } from "@/lib/channel-calendar/client";

afterEach(() => cleanup());

describe("ChannelCalendarLinkModal", () => {
  it("walks House, Rooms and Review and rejects malformed links before save", async () => {
    render(<ChannelCalendarLinkModal open onClose={() => {}} propertyIds={["p1"]} propertyOptions={[{ id: "p1", label: "4709A" }]} showToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    const input = screen.getByRole("textbox", { name: "Room 2 Airbnb calendar link" });
    fireEvent.change(input, { target: { value: "https://example.com/feed" } });
    expect(screen.getByText("Continue").closest("button")?.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("valid Airbnb");
    expect(saveChannelCalendarConnection).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "https://www.airbnb.com/calendar/ical/123.ics" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Ready to connect")).toBeTruthy();
    expect(screen.getByText("Save & sync")).toBeTruthy();
  });

  it("Escape closes only the open provider dropdown, not the whole Link calendars modal (C090/C092)", async () => {
    const onClose = vi.fn();
    render(
      <ChannelCalendarLinkModal
        open
        onClose={onClose}
        propertyIds={["p1"]}
        propertyOptions={[{ id: "p1", label: "4709A" }]}
        showToast={() => {}}
      />,
    );
    const trigger = document.querySelector('[data-attr="channel-calendar-link-provider"]') as HTMLElement;
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    // The dropdown closes...
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    // ...but the modal underneath it must not have been dismissed too.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Continue")).toBeTruthy();

    // With no dropdown open, Escape still closes the modal as normal.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
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
