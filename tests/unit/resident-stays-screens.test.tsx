// @vitest-environment jsdom
/**
 * Captures the batch's new surfaces as reviewable HTML: a guest's short stays as Application rows (Sent · Approved), the booking application (Stay with the taken nights crossed out, then Review) and the manager's Connect popup on the new Other calendar (iCal) channel.
 *
 * It is a render test first - each screen must come up with the copy the reviewer is checking - and an
 * evidence writer second: set `STAYS_SCREENS_DIR=<dir>` and each screen is written there as a
 * standalone `*.html` that loads `app.css` (the project's own compiled Tailwind), so the real pixels can
 * be screenshotted in a browser instead of read as a DOM dump. Behaviour itself is asserted in
 * `resident-stays-ui.test.tsx` and `channel-calendar-ical-modal.test.tsx`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { existsSync, writeFileSync } from "node:fs";
import type { GuestStay } from "@/lib/short-stay/guest-stays";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/resident/applications/approved",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "u1", email: "priya@example.com", ready: true }) }));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ loading: false, rooms: [{ roomChoice: "prop-1::r1", spans: [{ start: "2026-10-21", end: "2026-10-22", count: 1 }] }] }),
}));
vi.mock("@/lib/room-availability-range", async (orig) => ({ ...(await orig<typeof import("@/lib/room-availability-range")>()), pacificTodayKey: () => "2026-10-14" }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
  AppUiProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/rental-application/data", async (orig) => ({
  ...(await orig<typeof import("@/lib/rental-application/data")>()),
  getRoomOptionsForProperty: (id: string) => (id === "p1" ? [{ value: "p1::room-8", label: "Attic Nook" }, { value: "p1::room-9", label: "Garden Suite" }] : []),
  isEntireHomeProperty: () => false,
}));
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

const client = vi.hoisted(() => ({ fetchGuestStays: vi.fn(), fetchBookableListing: vi.fn(), postGuestStays: vi.fn() }));
vi.mock("@/lib/short-stay/guest-stays-client", async (orig) => ({ ...(await orig<typeof import("@/lib/short-stay/guest-stays-client")>()), ...client }));

import { StaysRowsHarness } from "../helpers/stays-rows-harness";
import { ResidentStayRequest } from "@/components/portal/resident-stay-request";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const base: GuestStay = {
  id: "s1", propertyId: "prop-1", roomId: "r1", propertyLabel: "Cedar Court", roomLabel: "Attic Nook",
  checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3, guests: 1, status: "confirmed", holdExpiresAt: null, total: 420, nightly: 140, canBookAgain: true,
};
const stays: GuestStay[] = [
  base,
  { ...base, id: "s2", roomLabel: "Garden Suite", roomId: "r4", checkIn: "2026-10-26", checkOut: "2026-10-27", nights: 1, guests: 3, status: "pending", holdExpiresAt: "2026-10-15T18:00:00Z", total: 270 },
  { ...base, id: "s3", checkIn: "2026-10-09", checkOut: "2026-10-10", nights: 1, total: 140 },
];
const listing = {
  propertyId: "prop-1", propertyLabel: "Cedar Court", confirmsInstantly: true,
  rooms: [{ id: "r1", label: "Attic Nook", nightly: 140, sleeps: 1 }, { id: "r4", label: "Garden Suite", nightly: 90, sleeps: 4 }],
};
const dry = (action: string, outcome = "confirmed") => ({
  ok: true, dryRun: true, action, summary: "", results: [{ checkIn: "2026-10-15", checkOut: "2026-10-16", nights: 1, total: 140, outcome }],
});

/* ─────────── evidence writer ─────────── */
const dir = process.env.STAYS_SCREENS_DIR?.trim() ?? "";
const written: string[] = [];

function capture(name: string, title: string, frame: { width: number; label: string }) {
  if (!dir) return;
  const body = document.body.innerHTML;
  const file = `${dir}/${name}.html`;
  writeFileSync(
    file,
    `<!doctype html>
<html data-theme="light"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="app.css">
<style>
  body { margin: 0; background: #eceef2; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .shot-head { padding: 14px 20px 10px; font: 600 13px/1.4 ui-sans-serif, system-ui, sans-serif; color: #4a4e56; }
  .shot-frame { width: ${frame.width}px; margin: 0 auto 22px; background: var(--background, #fcfcfd); color: var(--foreground, #17181a);
    border: 1px solid rgba(8,9,11,.12); border-radius: 12px; padding: 18px; overflow: hidden; }
</style></head>
<body><div class="shot-head">${title} — ${frame.label}</div><div class="shot-frame" id="capture-root">${body}</div></body></html>`,
    "utf8",
  );
  written.push(`${name}.html`);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T20:00:00Z"));
  vi.clearAllMocks();
  client.fetchGuestStays.mockResolvedValue(stays);
  client.fetchBookableListing.mockResolvedValue(listing);
  client.postGuestStays.mockResolvedValue(dry("confirm"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
afterAll(() => {
  if (dir) expect(existsSync(`${dir}/${written[0]}`)).toBe(true);
});

describe("the surfaces this batch adds, as a reviewer sees them", () => {
  it("Application · Approved shows the confirmed stay as an application row with its status as a plain fact", async () => {
    render(<StaysRowsHarness section="approved" />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="resident-stay-row"]')).toHaveLength(2));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Cedar Court · Attic Nook");
    expect(text).toContain("Short stay · Oct 20–23 · 3 nights");
    expect(text).toContain("Confirmed");
    expect(text).toContain("$420");
    expect(text).not.toMatch(/work order/i);
    capture("01-application-approved-stay", "Resident portal › Application › Approved (a short stay)", { width: 980, label: "desktop 980px" });
  });

  it("Application · Sent shows the requested stay with the host's hours left", async () => {
    render(<StaysRowsHarness section="sent" />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="resident-stay-row"]')).toHaveLength(1));
    expect(document.body.textContent).toContain("Requested, expires in 22h");
    capture("02-application-sent-stay", "Resident portal › Application › Sent (a short stay)", { width: 980, label: "desktop 980px" });
  });

  const prefill = { listing: "prop-1", room: "r1", checkIn: "2026-10-23", checkOut: "2026-10-24", guests: 1 };

  it("Request a stay · the Stay step draws the calendar with the taken nights crossed out", async () => {
    client.fetchBookableListing.mockResolvedValue({ ...listing, guestName: "Priya Natarajan", houseRules: "Quiet after 10 pm.", stayTimes: undefined });
    client.postGuestStays.mockResolvedValue({ ok: true, dryRun: true, action: "request", summary: "", results: [{ checkIn: "2026-10-23", checkOut: "2026-10-24", nights: 1, total: 140, outcome: "pending" }] });
    render(<ResidentStayRequest prefill={prefill} />);
    await waitFor(() => expect(document.querySelector('[data-attr="stay-request-calendar"]')).toBeTruthy());
    const taken = document.querySelector('[data-day="2026-10-21"]') as HTMLButtonElement;
    expect(taken.hasAttribute("data-taken")).toBe(true);
    expect(taken.className).toContain("line-through");
    expect(document.body.textContent).not.toMatch(/Quick book|Confirm stay/);
    capture("04-request-stay", "Resident portal › Request a stay › Stay", { width: 980, label: "desktop 980px" });
  });

  it("Request a stay · phone width renders the same application", async () => {
    render(<ResidentStayRequest prefill={prefill} />);
    await waitFor(() => expect(document.querySelector('[data-attr="stay-request-room"]')).toBeTruthy());
    capture("05-request-stay-phone", "Resident portal › Request a stay (phone)", { width: 390, label: "phone 390px" });
  });

  it("Manager Bookings · a guest's request offers Approve and Decline as icon actions", async () => {
    const request: PropertyBookingEntry = {
      source: "block", propertyId: "prop-1", propertyLabel: "Cedar Court", roomId: "r1", roomLabel: "Attic Nook", summary: "Priya N.",
      residentName: "Priya N.", blockId: "block-1", start: "2026-10-20", end: "2026-10-22", rate: 140, rateBasis: "daily", bookingStatus: "hold",
      reason: "Short-stay request", stayDetails: { source: "public_short_stay_request", holdExpiresAt: "2026-10-15T20:00:00Z" },
    } as PropertyBookingEntry;
    render(<BookingsEditSheet entry={request} entries={[request]} onClose={vi.fn()} onSave={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('[aria-label="Approve"]')).toBeTruthy());
    expect(document.querySelector('[aria-label="Decline"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="Approve"]')!.textContent?.trim()).toBe("");
    capture("08-manager-approve-decline", "Manager › Bookings › a guest's short-stay request", { width: 980, label: "desktop 980px" });
  });

  it("Connect · Other calendar asks for the site's name and takes any .ics link", async () => {
    const rooms = [
      { connectionId: "ical-room-8-Houfy", roomId: "room-8", roomLabel: "Attic Nook", provider: "ical", label: "Houfy", ranges: [], lastSyncedAt: null, lastError: null, hasImportUrl: true, importUrl: "https://www.houfy.com/calendar/export/room-8.ics", exportUrl: "https://proplane.ai/api/calendar/export/houfy-room-8.ics" },
      { connectionId: "ical-room-9", roomId: "room-9", roomLabel: "Garden Suite", provider: "ical", label: "Furnished Finder", ranges: [], lastSyncedAt: null, lastError: null, hasImportUrl: true, importUrl: "https://www.furnishedfinder.com/ical/room-9.ics", exportUrl: "https://proplane.ai/api/calendar/export/ff-room-9.ics" },
    ];
    render(
      <ChannelCalendarLinkModal
        open
        onClose={() => {}}
        entries={[]}
        propertyIds={["p1"]}
        propertyOptions={[{ id: "p1", label: "Cedar Court" }]}
        showToast={() => {}}
        initialProvider="ical"
        initialConnections={[{ propertyId: "p1", propertyLabel: "Cedar Court", rooms }] as never}
      />,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-attr="channel-calendar-room-row"]').length).toBeGreaterThan(0));
    expect(document.body.textContent).toContain("Other calendar");
    capture("07-connect-other-calendar", "Manager › Integrations › Bookings › Connect › Other calendar", { width: 980, label: "desktop 980px" });
  });
});
