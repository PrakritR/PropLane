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
  fetchManagerChannelBookings: vi.fn(async () => [{ propertyId: "p1", propertyLabel: "4709A", rooms: bookings.rooms }]),
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

  it("offers Connect on Airbnb and Booking.com, and Coming soon rows for Vrbo, SpareRoom and Furnished Finder", async () => {
    bookings.rooms = [];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-airbnb-manage"]')?.textContent).toBe("Connect"));
    expect(document.querySelector('[data-attr="settings-booking_com-manage"]')?.textContent).toBe("Connect");
    expect(document.querySelector('[data-attr="settings-vrbo-manage"]')).toBeNull();
    const text = document.body.textContent ?? "";
    for (const name of ["Vrbo", "SpareRoom", "Furnished Finder"]) expect(text).toContain(name);
    expect(text.match(/Coming soon/g)?.length).toBe(3);
    expect(text).not.toContain("Export booking calendar");
  });

  it("keeps an already-linked Vrbo manageable instead of hiding it behind Coming soon", async () => {
    bookings.rooms = [room("vrbo", "r1"), room("vrbo", "r3")];
    render(<ManagerBookingChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-vrbo-status"]')?.textContent).toBe("Connected · 2 rooms"));
    fireEvent.click(document.querySelector('[data-attr="settings-vrbo-manage"]') as HTMLElement);
    expect(screen.getByTestId("connect-modal").textContent).toBe("vrbo");
    expect((document.body.textContent ?? "").match(/Coming soon/g)?.length).toBe(2);
  });
});
