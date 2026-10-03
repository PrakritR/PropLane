// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.hoisted(() => vi.fn());
const room = (provider: string, roomId: string, hasImportUrl = true) => ({
  connectionId: `${provider}-${roomId}`, roomId, roomLabel: roomId, provider, label: null, ranges: [], lastSyncedAt: null, lastError: null, hasImportUrl,
  exportUrl: `https://proplane.ai/api/calendar/export/token-${roomId}.ics`,
});

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
vi.mock("@/components/portal/google-calendar-connect-panel", () => ({ GoogleCalendarConnectPanel: () => <div /> }));
vi.mock("@/components/portal/channel-calendar-link-modal", () => ({ ChannelCalendarLinkModal: ({ open, initialProvider }: { open: boolean; initialProvider?: string }) => open ? <div data-testid="connect-modal">{initialProvider}</div> : null }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  isEntireHomeProperty: () => false,
  getRoomOptionsForProperty: () => [{ value: "p1::r1", label: "Room 1" }, { value: "p1::r2", label: "Room 2" }, { value: "p1::r3", label: "Room 3" }],
}));
vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: vi.fn(async () => [{ propertyId: "p1", propertyLabel: "4709A", rooms: [room("airbnb", "r1"), room("booking_com", "r2"), room("airbnb", "r2", false)] }]),
  fetchRoomExportCalendarUrl: vi.fn(),
}));

import { ManagerSheetLinkPanel } from "@/components/portal/manager-sheet-link-panel";

afterEach(() => { cleanup(); toast.mockClear(); });

describe("Settings → Integrations channel rows", () => {
  it("counts only each channel's own links and opens the popup on that channel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ links: [], sheets: { connected: false, email: null, configured: true } }) })));
    render(<ManagerSheetLinkPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-booking_com-status"]')?.textContent).toBe("Connected · 1 room"));
    expect(document.querySelector('[data-attr="settings-airbnb-status"]')?.textContent).toBe("Connected · 1 room");
    fireEvent.click(document.querySelector('[data-attr="settings-booking_com-manage"]') as HTMLElement);
    expect(screen.getByTestId("connect-modal").textContent).toBe("booking_com");
  });
});

describe("ExportBookingCalendarDialog", () => {
  it("lists the existing links and Copy copies the full URL", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { ExportBookingCalendarDialog } = await import("@/components/portal/export-booking-calendar-dialog");
    render(<ExportBookingCalendarDialog open onClose={() => {}} propertyOptions={[{ id: "p1", label: "4709A" }]} showToast={toast} />);
    const field = await screen.findByLabelText("4709A · Room 1 export link");
    await waitFor(() => expect((field as HTMLInputElement).value).toBe("https://proplane.ai/api/calendar/export/token-r1.ics"));
    fireEvent.click(screen.getByLabelText("Copy 4709A · Room 1 link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://proplane.ai/api/calendar/export/token-r1.ics"));
    expect(toast).toHaveBeenCalledWith("Link copied");
    // Room 3 has no export link yet: it offers to create one instead of a copy.
    expect(screen.getByLabelText("Create export link for 4709A · Room 3")).toBeTruthy();
    expect(screen.getByLabelText("Paste into")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr="export-booking-calendar-steps"] li').length).toBeGreaterThanOrEqual(3);
    // Room 2 has a Booking.com link and an Airbnb one without an import: the default site (Airbnb) shows the Airbnb link.
    expect((screen.getByLabelText("4709A · Room 2 export link") as HTMLInputElement).value).toBe("https://proplane.ai/api/calendar/export/token-r2.ics");
  });
});
