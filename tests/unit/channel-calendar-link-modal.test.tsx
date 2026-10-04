// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const data = vi.hoisted(() => ({
  entireHome: new Set<string>(),
  rooms: {} as Record<string, { value: string; label: string }[]>,
}));

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getRoomOptionsForProperty: (id: string) => data.rooms[id] ?? [],
    isEntireHomeProperty: (id: string) => data.entireHome.has(id),
  };
});

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchChannelCalendarConnections: vi.fn(async () => []),
  fetchManagerChannelBookings: vi.fn(async () => []),
  fetchOccupancySnapshot: vi.fn(async () => ({ days: [] })),
  fetchRoomExportCalendarUrl: vi.fn(async () => "https://proplane.ai/api/calendar/export/token.ics"),
  saveChannelCalendarConnection: vi.fn(async (input: { propertyId: string; roomId: string }) => ({ id: `c-${input.roomId}`, hasImportUrl: true })),
  deleteChannelCalendarConnection: vi.fn(),
  syncChannelCalendarConnection: vi.fn(async () => ({})),
  syncAllChannelCalendarConnections: vi.fn(),
}));

import { ChannelCalendarLinkModal, channelCalendarLinkTitle } from "@/components/portal/channel-calendar-link-modal";
import { fetchManagerChannelBookings, fetchRoomExportCalendarUrl, saveChannelCalendarConnection, syncChannelCalendarConnection } from "@/lib/channel-calendar/client";

beforeEach(() => {
  data.entireHome = new Set();
  data.rooms = {
    p1: [{ value: "p1::room-2", label: "Room 2" }, { value: "p1::room-3", label: "Room 3" }],
    p2: [{ value: "p2::room-9", label: "Room 9" }],
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const options = [{ id: "p1", label: "4709A" }, { id: "p2", label: "Maple" }];
const baseProps = { open: true, initialProvider: "airbnb" as const, onClose: () => {}, entries: [], propertyIds: ["p1", "p2"], propertyOptions: options, showToast: () => {} };
const AIRBNB = "https://www.airbnb.com/calendar/ical/123.ics?s=abc";

async function ready() {
  await waitFor(() => expect(document.body.textContent).not.toContain("Loading linked rooms"));
}

describe("ChannelCalendarLinkModal (one page)", () => {
  it("is one page: a Link control, then a table of every room grouped by property, no steps", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    expect(screen.getByRole("dialog", { name: "Connect Airbnb" })).toBeTruthy();
    const scope = within(document.querySelector('[data-attr="channel-calendar-link-scope"]') as HTMLElement);
    expect(scope.getByText("Entire workspace")).toBeTruthy();
    expect(scope.getByText("Specific properties")).toBeTruthy();
    expect(screen.queryByText("Continue")).toBeNull();
    expect(screen.queryByRole("heading", { name: "House" })).toBeNull();
    const sections = Array.from(document.querySelectorAll('[data-attr="channel-calendar-link-table"] section')).map((s) => s.getAttribute("aria-label"));
    expect(sections).toEqual(["4709A", "Maple"]);
    for (const label of ["Room 2", "Room 3", "Room 9"]) {
      expect(screen.getByRole("textbox", { name: `${label} Airbnb calendar link` })).toBeTruthy();
      expect(screen.getByLabelText(`${label} PropLane export link`)).toBeTruthy();
    }
  });

  it("Specific properties adds a properties dropdown and lists only the chosen houses", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} initialPropertyId="p2" />);
    await ready();
    const sections = Array.from(document.querySelectorAll('[data-attr="channel-calendar-link-table"] section')).map((s) => s.getAttribute("aria-label"));
    expect(sections).toEqual(["Maple"]);
    expect(document.querySelector('[data-attr="channel-calendar-link-property"]')).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Room 2 Airbnb calendar link" })).toBeNull();
    await waitFor(() => expect(vi.mocked(fetchManagerChannelBookings)).toHaveBeenLastCalledWith(["p2"]));
  });

  it("Entire workspace has no properties dropdown", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    expect(document.querySelector('[data-attr="channel-calendar-link-property"]')).toBeNull();
    fireEvent.click(within(document.querySelector('[data-attr="channel-calendar-link-scope"]') as HTMLElement).getByText("Specific properties"));
    expect(document.querySelector('[data-attr="channel-calendar-link-property"]')).not.toBeNull();
    expect(screen.getByText("Pick a property to list its rooms.")).toBeTruthy();
  });

  it("rejects a malformed link inline and keeps Save off", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    const input = screen.getByRole("textbox", { name: "Room 2 Airbnb calendar link" });
    fireEvent.change(input, { target: { value: "https://example.com/feed" } });
    expect(screen.getByRole("alert").textContent).toContain("valid Airbnb");
    const save = screen.getByText("Save").closest("button") as HTMLButtonElement;
    expect(save.disabled || save.getAttribute("aria-disabled") === "true").toBe(true);
    fireEvent.click(screen.getByText("Save"));
    expect(saveChannelCalendarConnection).not.toHaveBeenCalled();
  });

  it("Save upserts every row with a pasted link, skips blanks, then syncs those", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Room 2 Airbnb calendar link" }), { target: { value: AIRBNB } });
    fireEvent.change(screen.getByRole("textbox", { name: "Room 9 Airbnb calendar link" }), { target: { value: `${AIRBNB}9` } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(saveChannelCalendarConnection).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveChannelCalendarConnection).mock.calls.map(([i]) => [i.propertyId, i.roomId, i.provider])).toEqual([
      ["p1", "room-2", "airbnb"],
      ["p2", "room-9", "airbnb"],
    ]);
    await waitFor(() => expect(syncChannelCalendarConnection).toHaveBeenCalledTimes(2));
    expect(vi.mocked(syncChannelCalendarConnection).mock.calls.map(([id]) => id)).toEqual(["c-room-2", "c-room-9"]);
  });

  it("Booking.com uses its own validator", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} initialProvider="booking_com" />);
    await ready();
    const input = screen.getByRole("textbox", { name: "Room 2 Booking.com calendar link" });
    fireEvent.change(input, { target: { value: AIRBNB } });
    expect(screen.getByRole("alert").textContent).toContain("valid Booking.com");
    fireEvent.change(input, { target: { value: "https://ical.booking.com/v1/export?t=abc" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Vrbo takes a Vrbo link and rejects an Airbnb link", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} initialProvider="vrbo" />);
    await ready();
    const input = screen.getByRole("textbox", { name: "Room 2 Vrbo calendar link" });
    fireEvent.change(input, { target: { value: AIRBNB } });
    expect(screen.getByRole("alert").textContent).toContain("valid Vrbo");
    fireEvent.change(input, { target: { value: "https://www.vrbo.com/icalendar/abc123.ics?nonTentative" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the PropLane link is read-only and Copy makes it on demand", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    const field = screen.getByLabelText("Room 2 PropLane export link") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe("");
    const row = field.closest('[data-attr="channel-calendar-room-row"]') as HTMLElement;
    fireEvent.click(within(row).getByLabelText("Copy PropLane calendar link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://proplane.ai/api/calendar/export/token.ics"));
    expect(fetchRoomExportCalendarUrl).toHaveBeenCalledWith({ propertyId: "p1", roomId: "room-2", roomLabel: "Room 2", provider: "airbnb" });
    await waitFor(() => expect((screen.getByLabelText("Room 2 PropLane export link") as HTMLInputElement).value).toBe("https://proplane.ai/api/calendar/export/token.ics"));
  });

  it("a room that already has a link shows it straight away", async () => {
    vi.mocked(fetchManagerChannelBookings).mockResolvedValue([{ propertyId: "p1", propertyLabel: "4709A", rooms: [{ connectionId: "c1", roomId: "room-2", roomLabel: "Room 2", provider: "airbnb", label: null, ranges: [], lastSyncedAt: null, lastError: null, hasImportUrl: true, exportUrl: "https://proplane.ai/api/calendar/export/existing.ics" }] }]);
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await waitFor(() => expect((screen.getByLabelText("Room 2 PropLane export link") as HTMLInputElement).value).toBe("https://proplane.ai/api/calendar/export/existing.ics"));
    expect((screen.getByRole("textbox", { name: "Room 2 Airbnb calendar link" }) as HTMLInputElement).placeholder).toContain("Connected");
    vi.mocked(fetchManagerChannelBookings).mockResolvedValue([]);
  });

  it("an entire-home listing shows one row for the house", async () => {
    data.entireHome = new Set(["p1"]);
    data.rooms = { p1: [] };
    render(<ChannelCalendarLinkModal {...baseProps} propertyIds={["p1"]} propertyOptions={[options[0]!]} />);
    await ready();
    expect(screen.getByRole("textbox", { name: "4709A Airbnb calendar link" })).toBeTruthy();
    expect(within(document.querySelector('[data-attr="channel-calendar-room-row"]') as HTMLElement).getByText("Whole house")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr="channel-calendar-room-row"]').length).toBe(1);
  });

  it("with no channel from the opener, a Channel dropdown leads the page and the title follows it", async () => {
    expect(channelCalendarLinkTitle("")).toBe("Connect a channel");
    expect(channelCalendarLinkTitle("booking_com")).toBe("Connect Booking.com");
    const { initialProvider: _omit, ...noChannel } = baseProps;
    void _omit;
    render(<ChannelCalendarLinkModal {...noChannel} />);
    expect(screen.getByRole("dialog", { name: "Connect a channel" })).toBeTruthy();
    expect(document.querySelector('[data-attr="channel-calendar-link-provider"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="channel-calendar-link-choose-vrbo"]')).toBeNull();
  });

  it("uses the standard popup frame: one footer, a live preview, no raw select", async () => {
    render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    expect(document.querySelectorAll("select").length).toBe(0);
    expect(document.querySelectorAll('[data-attr="channel-calendar-link-save"]').length).toBe(1);
    const preview = screen.getByLabelText("What will be linked");
    expect(preview.textContent).toContain("Entire workspace");
    expect(preview.textContent).toContain("Room 2");
  });

  it("does not remount into Loading linked rooms when the parent refreshes", async () => {
    const { rerender } = render(<ChannelCalendarLinkModal {...baseProps} />);
    await ready();
    rerender(<ChannelCalendarLinkModal {...baseProps} onChanged={() => {}} />);
    expect(document.body.textContent).not.toContain("Loading linked rooms");
  });
});
