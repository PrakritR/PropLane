// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const roomsState = vi.hoisted(() => ({ entireHome: false, rooms: [{ value: "p1::room-2", label: "Room 2" }] as { value: string; label: string }[] }));

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getRoomOptionsForProperty: () => roomsState.rooms,
    isEntireHomeProperty: () => roomsState.entireHome,
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

import { ChannelCalendarLinkModal, channelCalendarLinkTitle } from "@/components/portal/channel-calendar-link-modal";
import { fetchChannelCalendarConnections, fetchRoomExportCalendarUrl, saveChannelCalendarConnection } from "@/lib/channel-calendar/client";

afterEach(() => {
  cleanup();
  roomsState.entireHome = false;
  roomsState.rooms = [{ value: "p1::room-2", label: "Room 2" }];
});

const baseProps = { open: true, initialProvider: "airbnb" as const, onClose: () => {}, entries: [], propertyIds: ["p1"], propertyOptions: [{ id: "p1", label: "4709A" }], showToast: () => {} };

describe("ChannelCalendarLinkModal", () => {
  it("walks House, Rooms and Review and rejects malformed links before save", async () => {
    render(<ChannelCalendarLinkModal open initialProvider="airbnb" onClose={() => {}} entries={[]} propertyIds={["p1"]} propertyOptions={[{ id: "p1", label: "4709A" }]} showToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    const input = screen.getByRole("textbox", { name: "Room 2 Airbnb calendar link" });
    fireEvent.change(input, { target: { value: "https://example.com/feed" } });
    expect(screen.getByText("Continue").closest("button")?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.queryByText("Ready to connect")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("valid Airbnb");
    expect(saveChannelCalendarConnection).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "https://www.airbnb.com/calendar/ical/123.ics" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getAllByText("Ready to connect").length).toBe(2);
    expect(screen.getByText("Connect", { selector: "button" })).toBeTruthy();
  });

  it("uses the standard wizard frame: rail steps, one footer, a real preview, no raw select", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    expect(document.querySelector('[aria-label="Step progress"]')).not.toBeNull();
    expect(document.querySelectorAll("select").length).toBe(0);
    expect(document.querySelectorAll('[data-attr="channel-calendar-link-next"]').length).toBe(1);
    const preview = screen.getByLabelText("What will be linked");
    expect(preview.textContent).toContain("4709A");
    expect(preview.textContent).toContain("Room 2");
    expect(preview.textContent).not.toContain("No changes");
  });

  it("the title follows the channel the opener passed, and there is no Channel field", async () => {
    expect(channelCalendarLinkTitle("")).toBe("Connect a channel");
    expect(channelCalendarLinkTitle("airbnb")).toBe("Connect Airbnb");
    expect(channelCalendarLinkTitle("vrbo")).toBe("Connect Vrbo");
    for (const [provider, title] of [["airbnb", "Connect Airbnb"], ["booking_com", "Connect Booking.com"], ["vrbo", "Connect Vrbo"]] as const) {
      const view = render(<ChannelCalendarLinkModal {...baseProps} initialProvider={provider} />);
      expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
      expect(document.querySelector('[data-attr="channel-calendar-link-provider"]')).toBeNull();
      expect(document.querySelector('[data-attr="channel-calendar-link-channels"]')).toBeNull();
      expect(screen.queryByText("Channel", { selector: "label, span, h2, h3" })).toBeNull();
      view.unmount();
    }
  });

  it("with no channel from the opener, a chooser of Airbnb / Booking.com / Vrbo comes first, then the House step", async () => {
    const { initialProvider: _omit, ...noChannel } = baseProps;
    void _omit;
    render(<ChannelCalendarLinkModal {...noChannel} />);
    expect(screen.getByRole("dialog", { name: "Connect a channel" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Channel" })).toBeTruthy();
    const tiles = Array.from(document.querySelectorAll('[data-attr^="channel-calendar-link-choose-"]')).map((el) => el.textContent);
    expect(tiles).toEqual(["Airbnb", "Booking.com", "Vrbo"]);
    expect(screen.getByText("Continue").closest("button")?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(document.querySelector('[data-attr="channel-calendar-link-choose-vrbo"]') as HTMLElement);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Connect Vrbo" })).toBeTruthy());
    expect(screen.getByRole("heading", { name: "House" })).toBeTruthy();
    expect(screen.getByLabelText("What will be linked").textContent).toContain("Vrbo");
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByRole("textbox", { name: "Room 2 Vrbo calendar link" })).toBeTruthy();
  });

  it("Vrbo takes a Vrbo link and rejects an Airbnb link", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} initialProvider="vrbo" />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    const input = screen.getByRole("textbox", { name: "Room 2 Vrbo calendar link" });
    fireEvent.change(input, { target: { value: "https://www.airbnb.com/calendar/ical/123.ics?s=abc" } });
    expect(screen.getByRole("alert").textContent).toContain("valid Vrbo");
    fireEvent.change(input, { target: { value: "https://www.vrbo.com/icalendar/abc123.ics?nonTentative" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getAllByText("Ready to connect").length).toBe(2);
  });

  it("a room with no export link offers Generate link, then shows the link with Copy and Preview", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} initialProvider="booking_com" />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Not set up")).toBeTruthy();
    expect(screen.queryByLabelText("Room 2 PropLane export link")).toBeNull();
    const generate = document.querySelector('[data-attr="channel-calendar-generate-link"]') as HTMLElement;
    expect(generate.textContent).toBe("Generate link");
    fireEvent.click(generate);
    const field = await screen.findByLabelText("Room 2 PropLane export link");
    expect((field as HTMLInputElement).value).toBe("https://proplane.ai/api/calendar/export/token.ics");
    expect(fetchRoomExportCalendarUrl).toHaveBeenCalledWith({ propertyId: "p1", roomId: "room-2", roomLabel: "Room 2", provider: "booking_com" });
    expect(screen.getByText("Link ready")).toBeTruthy();
    expect(screen.getByLabelText("Copy PropLane calendar link")).toBeTruthy();
    expect(screen.getByLabelText("Feed preview")).toBeTruthy();
    expect(document.querySelector('[data-attr="channel-calendar-generate-link"]')).toBeNull();
  });

  it("a room that already has a link shows it straight away, with no Generate link", async () => {
    vi.mocked(fetchChannelCalendarConnections).mockResolvedValueOnce([{ id: "c1", propertyId: "p1", roomId: "room-2", provider: "booking_com", label: "Room 2", hasImportUrl: false, exportUrl: "https://proplane.ai/api/calendar/export/existing.ics", importedRangeCount: 0, lastSyncedAt: null, lastError: null }]);
    render(<ChannelCalendarLinkModal {...baseProps} initialProvider="booking_com" />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect((screen.getByLabelText("Room 2 PropLane export link") as HTMLInputElement).value).toBe("https://proplane.ai/api/calendar/export/existing.ics"));
    expect(screen.getByText("Link ready")).toBeTruthy();
    expect(document.querySelector('[data-attr="channel-calendar-generate-link"]')).toBeNull();
  });

  it("an entire-home listing offers the whole house as the one unit to link", async () => {
    roomsState.entireHome = true;
    roomsState.rooms = [];
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.queryByText(/no rooms/i)).toBeNull();
    expect(screen.getByRole("textbox", { name: "4709A Airbnb calendar link" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Whole house" })).toBeTruthy();
  });

  it("a room-based listing with no rooms says so and offers a way back", async () => {
    roomsState.rooms = [];
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Continue").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("This house has no rooms listed.")).toBeTruthy();
    fireEvent.click(screen.getByText("Choose another house"));
    expect(screen.getByRole("heading", { name: "House" })).toBeTruthy();
  });

  it("Escape closes only the open house dropdown, not the whole Link calendars modal (C090/C092)", async () => {
    const onClose = vi.fn();
    render(
      <ChannelCalendarLinkModal
        open
        onClose={onClose}
        initialProvider="airbnb"
        entries={[]} propertyIds={["p1"]}
        propertyOptions={[{ id: "p1", label: "4709A" }]}
        showToast={() => {}}
      />,
    );
    const trigger = document.querySelector('[data-attr="channel-calendar-link-property"]') as HTMLElement;
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
      entries: [],
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
