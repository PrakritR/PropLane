// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.hoisted(() => vi.fn());
const room = (provider: string, roomId: string, hasImportUrl = true) => ({
  connectionId: `${provider}-${roomId}`, roomId, roomLabel: roomId, provider, label: null, ranges: [], lastSyncedAt: null, lastError: null, hasImportUrl,
  exportUrl: `https://proplane.ai/api/calendar/export/token-${roomId}.ics`,
});
const bookings = vi.hoisted(() => ({ rooms: [] as unknown[] }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: toast }),
}));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => {
    const active = { id: "w1", name: "Seattle", owned: true, canManageMembers: true, propertyIds: ["p1"], propertyLabels: { p1: "4709A" } };
    return { workspaces: [active], active };
  },
}));
vi.mock("@/components/portal/channel-calendar-link-modal", () => ({ ChannelCalendarLinkModal: ({ open, initialProvider }: { open: boolean; initialProvider?: string }) => open ? <div data-testid="connect-modal">{initialProvider}</div> : null }));
vi.mock("@/lib/channel-calendar/property-units", () => ({
  channelCalendarUnits: (propertyId: string) => [
    { id: `${propertyId}-u1`, label: "Room 1", name: "Room 1" },
    { id: `${propertyId}-u2`, label: "Room 2", name: "Room 2" },
  ],
}));
vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: vi.fn<(ids: string[], opts?: { slim?: boolean }) => Promise<unknown[]>>(async () => [{ propertyId: "p1", propertyLabel: "4709A", rooms: bookings.rooms }]),
  fetchRoomExportCalendarUrl: vi.fn(),
}));

import { ManagerBookingChannelsPanel } from "@/components/portal/integrations-bookings-panel";

afterEach(() => { cleanup(); toast.mockClear(); });

describe("Settings → Integrations → Bookings", () => {
  it("counts only each channel's own links and opens the popup on that channel", async () => {
    bookings.rooms = [room("airbnb", "r1"), room("booking_com", "r2"), room("airbnb", "r2", false)];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-booking_com-status"]')?.textContent).toBe("Connected · 1 of 2 rooms · both ways · 1 needs a listing"));
    expect(document.querySelector('[data-attr="settings-airbnb-status"]')?.textContent).toBe("Connected · 1 of 2 rooms · both ways · 1 needs a listing");
    expect(document.querySelector('[data-attr="settings-airbnb-manage"]')?.textContent).toBe("Connect");
    expect(document.querySelector('[data-attr="settings-booking_com-manage"]')?.textContent).toBe("Connect");
    fireEvent.click(document.querySelector('[data-attr="settings-booking_com-manage"]') as HTMLElement);
    expect(screen.getByTestId("connect-modal").textContent).toBe("booking_com");
  });

  it("offers Connect on Airbnb and Booking.com and an Other calendar row, with a Coming soon row for Vrbo, and no SpareRoom (it posts from the Posting tab)", async () => {
    bookings.rooms = [];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-airbnb-manage"]')?.textContent).toBe("Connect"));
    expect(document.querySelector('[data-attr="settings-booking_com-manage"]')?.textContent).toBe("Connect");
    expect(document.querySelector('[data-attr="settings-vrbo-manage"]')).toBeNull();
    const text = document.body.textContent ?? "";
    for (const name of ["Vrbo", "Other calendar"]) expect(text).toContain(name);
    expect(text).not.toContain("SpareRoom");
    // Furnished Finder is no longer its own row: it is named on Other calendar, which links any .ics.
    expect(document.querySelector('[data-attr="settings-furnished-finder-row"]')).toBeNull();
    expect(document.querySelector('[data-attr="settings-ical-status"]')?.textContent).toBe("Houfy, Furnished Finder, Vrbo, any .ics");
    expect(text.match(/Coming soon/g)?.length).toBe(1);
    expect(text).not.toContain("Export booking calendar");
  });

  it("PadSplit is a plain manual row: it says what it does, and its action opens the host dashboard in a new tab", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-padsplit-row"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="settings-padsplit-status"]')?.textContent).toBe("Manual · approve each booking in PadSplit");
    expect(document.querySelector('[data-attr="settings-padsplit-manage"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="settings-padsplit-open"]') as HTMLElement);
    expect(open).toHaveBeenCalledWith("https://www.padsplit.com/host", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("keeps an already-linked Vrbo manageable instead of hiding it behind Coming soon", async () => {
    bookings.rooms = [room("vrbo", "r1"), room("vrbo", "r3")];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-vrbo-status"]')?.textContent).toBe("Connected · 2 rooms"));
    fireEvent.click(document.querySelector('[data-attr="settings-vrbo-manage"]') as HTMLElement);
    expect(screen.getByTestId("connect-modal").textContent).toBe("vrbo");
    expect(document.body.textContent ?? "").not.toContain("Coming soon");
  });

  it("counts Other calendar links per site and opens the popup on ical, handing it the loaded rooms", async () => {
    bookings.rooms = [{ ...room("ical", "r1"), label: "Houfy" }, { ...room("ical", "r1"), connectionId: "ical-r1-ff", label: "Furnished Finder" }, { ...room("ical", "r2"), label: "Houfy" }];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-ical-status"]')?.textContent).toBe("Connected · 3 links · Houfy, Furnished Finder"));
    fireEvent.click(document.querySelector('[data-attr="settings-ical-manage"]') as HTMLElement);
    expect(screen.getByTestId("connect-modal").textContent).toBe("ical");
  });

  it("reads rooms and links only (slim), never the stored stays that made this read time out", async () => {
    const { fetchManagerChannelBookings } = await import("@/lib/channel-calendar/client");
    bookings.rooms = [];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(fetchManagerChannelBookings).toHaveBeenCalled());
    expect(vi.mocked(fetchManagerChannelBookings).mock.calls[0]![1]).toEqual({ slim: true });
  });

  it("every channel row stacks its fact and action under the name on a phone", async () => {
    bookings.rooms = [];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-airbnb-manage"]')).not.toBeNull());
    for (const id of ["settings-airbnb-manage", "settings-booking_com-manage", "settings-padsplit-open", "settings-ical-manage"]) {
      const row = document.querySelector(`[data-attr="${id}"]`)?.closest('[data-integration-actions]')?.parentElement as HTMLElement;
      expect(row.className).toContain("max-sm:flex-wrap");
      expect(row.querySelector('[data-integration-actions="stacked"]')?.className).toContain("max-sm:basis-full");
    }
    const fact = document.querySelector('[data-attr="settings-padsplit-status"]') as HTMLElement;
    expect(fact.className).toContain("max-sm:flex-1");
  });
});
