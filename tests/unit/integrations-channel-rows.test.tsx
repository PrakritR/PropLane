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
  getRoomOptionsForProperty: () => [{ value: "p1::r1", label: "Room 1 · 3rd floor · $2100/mo" }, { value: "p1::r2", label: "Room 2" }, { value: "p1::r3", label: "Room 3" }],
}));
vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: vi.fn(async () => [{ propertyId: "p1", propertyLabel: "4709A", rooms: [room("airbnb", "r1"), room("booking_com", "r2"), room("airbnb", "r2", false), room("vrbo", "r1"), room("vrbo", "r3")] }]),
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
    expect(document.querySelector('[data-attr="settings-vrbo-status"]')?.textContent).toBe("Connected · 2 rooms");
    fireEvent.click(document.querySelector('[data-attr="settings-booking_com-manage"]') as HTMLElement);
    expect(screen.getByTestId("connect-modal").textContent).toBe("booking_com");
  });

  it("lists Airbnb, Booking.com and Vrbo as channel rows, in that order, and no Export booking calendar row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ links: [], sheets: { connected: false, email: null, configured: true } }) })));
    render(<ManagerSheetLinkPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-vrbo-status"]')?.textContent).toBe("Connected · 2 rooms"));
    const rows = ["airbnb", "booking_com", "vrbo"].map((p) => document.querySelector(`[data-attr="settings-${p}-manage"]`) as HTMLElement);
    expect(rows.every(Boolean)).toBe(true);
    expect(rows.map((el) => el.closest("div")?.parentElement?.parentElement?.textContent ?? "")).toEqual([expect.stringContaining("Airbnb"), expect.stringContaining("Booking.com"), expect.stringContaining("Vrbo")]);
    expect(document.body.textContent).not.toContain("Export booking calendar");
    expect(document.querySelector('[data-attr="settings-export-booking-calendar"]')).toBeNull();
  });

  it("Connect on the Vrbo row opens the popup on Vrbo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ links: [], sheets: { connected: false, email: null, configured: true } }) })));
    render(<ManagerSheetLinkPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-vrbo-status"]')?.textContent).toBe("Connected · 2 rooms"));
    fireEvent.click(document.querySelector('[data-attr="settings-vrbo-manage"]') as HTMLElement);
    expect(screen.getByTestId("connect-modal").textContent).toBe("vrbo");
  });
});
