// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getRoomOptionsForProperty: (id: string) => (id === "p1" ? [{ value: "p1::room-8", label: "Room 8" }, { value: "p1::room-9", label: "Room 9" }] : []),
    isEntireHomeProperty: () => false,
  };
});

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchChannelCalendarConnections: vi.fn(async () => []),
  fetchManagerChannelBookings: vi.fn(async () => []),
  fetchOccupancySnapshot: vi.fn(async () => ({ days: [] })),
  fetchRoomExportCalendarUrl: vi.fn(async () => "https://proplane.ai/api/calendar/export/new.ics"),
  fetchWritableChannelCalendarPropertyIds: vi.fn(async (ids: string[]) => ids),
  saveChannelCalendarConnection: vi.fn(async (input: { roomId: string }) => ({ id: `c-${input.roomId}`, hasImportUrl: true })),
  deleteChannelCalendarConnection: vi.fn(),
  syncChannelCalendarConnection: vi.fn(async () => ({})),
  syncAllChannelCalendarConnections: vi.fn(),
  validateChannelImportUrl: vi.fn(async () => ({ ok: true, eventCount: 4 })),
}));

import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { fetchManagerChannelBookings, fetchRoomExportCalendarUrl, saveChannelCalendarConnection, syncChannelCalendarConnection, validateChannelImportUrl } from "@/lib/channel-calendar/client";

const room = (provider: string, roomId: string, label: string | null) => ({
  connectionId: `${provider}-${roomId}-${label}`, roomId, roomLabel: roomId, provider, label, ranges: [], lastSyncedAt: null, lastError: null,
  hasImportUrl: true, importUrl: `https://www.houfy.com/calendar/export/${roomId}.ics`, exportUrl: `https://proplane.ai/api/calendar/export/${label}-${roomId}.ics`,
});
const loaded = [{ propertyId: "p1", propertyLabel: "4709A", rooms: [room("ical", "room-8", "Houfy"), room("ical", "room-8", "Furnished Finder"), room("airbnb", "room-9", null)] }];
const props = { open: true, onClose: () => {}, entries: [], propertyIds: ["p1"], propertyOptions: [{ id: "p1", label: "4709A" }], showToast: () => {} };

beforeEach(() => {
  vi.mocked(fetchManagerChannelBookings).mockImplementation(async () => []);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Connect modal opens without waiting on a read", () => {
  it("renders every room at once from the links already loaded while the refresh is still running, with no timeout message", async () => {
    // A refresh that never answers: the old modal sat on "Loading linked rooms…" and then threw "That took too long".
    vi.mocked(fetchManagerChannelBookings).mockImplementation(() => new Promise(() => {}));
    render(<ChannelCalendarLinkModal {...props} initialProvider="airbnb" initialConnections={loaded as never} />);
    expect(screen.queryByText(/Loading linked rooms/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Room 8 Airbnb calendar link" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Room 9 Airbnb calendar link" })).toBeTruthy();
    expect(screen.queryByText(/too long/i)).toBeNull();
    await waitFor(() => expect(fetchManagerChannelBookings).toHaveBeenCalled());
    expect(vi.mocked(fetchManagerChannelBookings).mock.calls[0]![1]).toEqual({ slim: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a refresh that fails or times out keeps the rooms and says nothing", async () => {
    vi.mocked(fetchManagerChannelBookings).mockRejectedValue(new Error("That took too long. Check your connection and try again."));
    render(<ChannelCalendarLinkModal {...props} initialProvider="airbnb" initialConnections={loaded as never} />);
    await waitFor(() => expect(fetchManagerChannelBookings).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Room 9 Airbnb calendar link" })).toBeTruthy();
  });

  it("every room row carries its PropLane export link and a Copy action", async () => {
    render(<ChannelCalendarLinkModal {...props} initialProvider="airbnb" initialConnections={loaded as never} />);
    const rows = Array.from(document.querySelectorAll('[data-attr="channel-calendar-room-row"]'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row as HTMLElement).getByLabelText("Copy PropLane calendar link")).toBeTruthy();
    }
    expect((screen.getByLabelText("Room 9 PropLane export link") as HTMLInputElement).value).toBe("https://proplane.ai/api/calendar/export/null-room-9.ics");
  });
});

describe("Connect modal · Other calendar", () => {
  const open = () => render(<ChannelCalendarLinkModal {...props} initialProvider="ical" initialConnections={loaded as never} />);

  it("asks for the site's name, titles the popup Other calendar, and keeps Save off until it is named", async () => {
    open();
    expect(screen.getByRole("dialog", { name: "Connect Other calendar" })).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Room 8 Other calendar calendar link" });
    fireEvent.change(input, { target: { value: "https://www.furnishedfinder.com/ical/77.ics" } });
    const save = screen.getByText("Save").closest("button") as HTMLButtonElement;
    expect(save.disabled || save.getAttribute("aria-disabled") === "true").toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Furnished Finder" } });
    await waitFor(() => expect((screen.getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows the named site's saved link on a room and nothing from the other site", () => {
    open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "houfy" } });
    expect((screen.getByRole("textbox", { name: /Room 8 houfy calendar link/i }) as HTMLInputElement).value).toBe("https://www.houfy.com/calendar/export/room-8.ics");
    expect((screen.getByLabelText("Room 8 PropLane export link") as HTMLInputElement).value).toContain("Houfy-room-8");
    expect((screen.getByRole("textbox", { name: /Room 9 houfy calendar link/i }) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Furnished Finder" } });
    expect((screen.getByLabelText("Room 8 PropLane export link") as HTMLInputElement).value).toContain("Furnished Finder-room-8");
  });

  it("accepts any https .ics, refuses a private host or an http link inline", () => {
    open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Expedia" } });
    const input = screen.getByRole("textbox", { name: "Room 9 Expedia calendar link" });
    fireEvent.change(input, { target: { value: "https://partner.expedia.example/feeds/r9.ics" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(input, { target: { value: "http://partner.expedia.example/feeds/r9.ics" } });
    expect(screen.getByRole("alert").textContent).toContain("valid Expedia");
    fireEvent.change(input, { target: { value: "https://192.168.1.4/feeds/r9.ics" } });
    expect(screen.getByRole("alert").textContent).toContain("valid Expedia");
  });

  it("the check icon asks the server, shows the block count, and offers a retry icon when it fails", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Expedia" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Room 9 Expedia calendar link" }), { target: { value: "https://partner.expedia.example/feeds/r9.ics" } });
    fireEvent.click(screen.getByLabelText("Check link"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Valid calendar · 4 blocks"));
    expect(validateChannelImportUrl).toHaveBeenCalledWith("https://partner.expedia.example/feeds/r9.ics");
    vi.mocked(validateChannelImportUrl).mockResolvedValueOnce({ ok: false, error: "That link did not return a calendar." });
    fireEvent.click(screen.getByLabelText("Check link"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("did not return a calendar"));
    expect(screen.getByLabelText("Check link again")).toBeTruthy();
  });

  it("a check that cannot finish says so and does not block Save", async () => {
    vi.mocked(validateChannelImportUrl).mockRejectedValueOnce(new Error("That took too long."));
    open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Expedia" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Room 9 Expedia calendar link" }), { target: { value: "https://partner.expedia.example/feeds/r9.ics" } });
    fireEvent.click(screen.getByLabelText("Check link"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not check that link in time"));
    expect((screen.getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Save sends the typed name as the label, then syncs; export Copy uses the named link", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Expedia" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Room 9 Expedia calendar link" }), { target: { value: "https://partner.expedia.example/feeds/r9.ics" } });
    const row9 = screen.getByLabelText("Room 9 PropLane export link").closest('[data-attr="channel-calendar-room-row"]') as HTMLElement;
    fireEvent.click(within(row9).getByLabelText("Copy PropLane calendar link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://proplane.ai/api/calendar/export/new.ics"));
    expect(fetchRoomExportCalendarUrl).toHaveBeenCalledWith({ propertyId: "p1", roomId: "room-9", roomLabel: "Expedia", provider: "ical" });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(saveChannelCalendarConnection).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveChannelCalendarConnection).mock.calls[0]![0]).toMatchObject({ provider: "ical", label: "Expedia", roomId: "room-9", importUrl: "https://partner.expedia.example/feeds/r9.ics" });
    await waitFor(() => expect(syncChannelCalendarConnection).toHaveBeenCalledWith("c-room-9"));
  });
});
