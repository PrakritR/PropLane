// @vitest-environment jsdom
/**
 * Render-level proof for the guest's Stays page: the list rows say their status as plain facts (no pill:
 * Requested, Approved with Pay, Confirmed, Declined, Expired), "Request again" and the round + open the booking
 * application (`/stays/request`) with the house and room prefilled, and an approved row sends the guest to
 * Payments. The application itself is `resident-stay-request-ui.test.tsx`. The network client is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GuestStay } from "@/lib/short-stay/guest-stays";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/resident/stays/upcoming",
  useSearchParams: () => new URLSearchParams(),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "u1", email: "priya@example.com", ready: true }) }));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ loading: false, rooms: [{ roomChoice: "prop-1::r1", spans: [{ start: "2026-10-21", end: "2026-10-21", count: 1 }] }] }),
}));
vi.mock("@/lib/room-availability-range", async (orig) => ({ ...(await orig<typeof import("@/lib/room-availability-range")>()), pacificTodayKey: () => "2026-10-14" }));

const client = vi.hoisted(() => ({ fetchGuestStays: vi.fn(), fetchBookableListing: vi.fn(), postGuestStays: vi.fn() }));
vi.mock("@/lib/short-stay/guest-stays-client", async (orig) => ({ ...(await orig<typeof import("@/lib/short-stay/guest-stays-client")>()), ...client }));

import { ResidentStaysPanel } from "@/components/portal/resident-stays-panel";

const base: GuestStay = {
  id: "s1", propertyId: "prop-1", roomId: "r1", propertyLabel: "Cedar Court", roomLabel: "Attic Nook",
  checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3, guests: 1, status: "confirmed", holdExpiresAt: null, total: 420, nightly: 140, canBookAgain: true,
};
const stays: GuestStay[] = [
  base,
  { ...base, id: "s2", checkIn: "2026-10-26", checkOut: "2026-10-27", nights: 1, status: "pending", holdExpiresAt: "2026-10-15T18:00:00Z", total: 140 },
  { ...base, id: "s3", checkIn: "2026-10-09", checkOut: "2026-10-10", nights: 1, total: 140 },
];
const listing = { propertyId: "prop-1", propertyLabel: "Cedar Court", confirmsInstantly: true, rooms: [{ id: "r1", label: "Attic Nook", nightly: 140, sleeps: 1 }, { id: "r4", label: "Garden Suite", nightly: 90, sleeps: 4 }] };
const dry = (action: string, outcome = "confirmed") => ({
  ok: true, dryRun: true, action, summary: "", results: [{ checkIn: "2026-10-15", checkOut: "2026-10-16", nights: 1, total: 140, outcome }],
});

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

describe("Stays list", () => {
  it("Upcoming lists confirmed and pending stays with plain status facts and the figure, no pill", async () => {
    render(<ResidentStaysPanel bucket="upcoming" />);
    expect(await screen.findByText("Requested, expires in 22h")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    const rows = [...document.querySelectorAll('[data-attr="resident-stay-row"]')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Cedar Court · Attic Nook");
    expect(rows[0]!.textContent).toContain("Oct 20 → Oct 23");
    expect(rows[0]!.textContent).toContain("$420");
    expect(document.querySelector('[data-attr="resident-stays-tab-upcoming"]')?.textContent).toContain("2");
    expect(document.querySelector('[data-attr="resident-stays-tab-past"]')?.textContent).toContain("1");
  });

  it("Past lists a completed stay and opens the booking application with its house and room prefilled", async () => {
    render(<ResidentStaysPanel bucket="past" />);
    const row = (await screen.findByText("Completed")).closest('[data-record-row]') as HTMLElement;
    fireEvent.click(within(row).getByText("Cedar Court · Attic Nook"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/resident/stays/request?listing=prop-1&room=r1&guests=1"));
    // No sheet, no quick picks: the application is a page.
    expect(document.querySelector('[data-attr="book-again-sheet"]')).toBeNull();
  });

  it("an approved stay says Approved, pay now and opens Payments; Declined and Expired stay in Upcoming", async () => {
    client.fetchGuestStays.mockResolvedValue([
      { ...base, id: "a1", payment: "due" },
      { ...base, id: "d1", status: "declined", checkIn: "2026-10-27", checkOut: "2026-10-28", nights: 1 },
      { ...base, id: "e1", status: "expired", checkIn: "2026-10-29", checkOut: "2026-10-30", nights: 1 },
    ]);
    render(<ResidentStaysPanel bucket="upcoming" />);
    const pay = (await screen.findByText("Approved, pay now")).closest('[data-record-row]') as HTMLElement;
    expect(screen.getByText("Declined")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    fireEvent.click(within(pay).getByText("Cedar Court · Attic Nook"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/resident/payments/pending"));
  });

  it("says so when there is nothing yet, with a way to find a room", async () => {
    client.fetchGuestStays.mockResolvedValue([]);
    render(<ResidentStaysPanel bucket="upcoming" />);
    expect(await screen.findByText("No upcoming stays")).toBeTruthy();
    expect(screen.getByText("Find a room")).toBeTruthy();
  });

  it("offers a retry when the list cannot load", async () => {
    client.fetchGuestStays.mockRejectedValue(new Error("boom"));
    render(<ResidentStaysPanel bucket="upcoming" />);
    expect(await screen.findByText("Couldn't load your stays")).toBeTruthy();
  });
});
