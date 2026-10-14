// @vitest-environment jsdom
/**
 * Render-level proof for the guest's Stays page and the Book again sheet: the list rows say their status as
 * plain facts (no pill), a past row opens the sheet with its room prefilled, the quick picks and the
 * calendar fill the cart, taken nights are crossed out, the primary button wording comes from the SERVER's
 * dry run, and a 409 race keeps the cart. The network client is mocked; its routes have their own tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GuestStay } from "@/lib/short-stay/guest-stays";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/resident/stays/upcoming",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "u1", email: "priya@example.com", ready: true }) }));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ loading: false, rooms: [{ roomChoice: "prop-1::r1", spans: [{ start: "2026-10-21", end: "2026-10-21", count: 1 }] }] }),
}));
vi.mock("@/lib/room-availability-range", async (orig) => ({ ...(await orig<typeof import("@/lib/room-availability-range")>()), pacificTodayKey: () => "2026-10-14" }));

const client = vi.hoisted(() => ({ fetchGuestStays: vi.fn(), fetchBookableListing: vi.fn(), postGuestStays: vi.fn() }));
vi.mock("@/lib/short-stay/guest-stays-client", async (orig) => ({ ...(await orig<typeof import("@/lib/short-stay/guest-stays-client")>()), ...client }));

import { ResidentStaysPanel } from "@/components/portal/resident-stays-panel";
import { BookAgainSheet } from "@/components/portal/book-again-sheet";
import { GuestStaysError } from "@/lib/short-stay/guest-stays-client";

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
    expect(await screen.findByText("Pending, expires in 22h")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    const rows = [...document.querySelectorAll('[data-attr="resident-stay-row"]')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Cedar Court · Attic Nook");
    expect(rows[0]!.textContent).toContain("Oct 20 → Oct 23");
    expect(rows[0]!.textContent).toContain("$420");
    expect(document.querySelector('[data-attr="resident-stays-tab-upcoming"]')?.textContent).toContain("2");
    expect(document.querySelector('[data-attr="resident-stays-tab-past"]')?.textContent).toContain("1");
  });

  it("Past lists a completed stay and opens Book again with its room prefilled", async () => {
    render(<ResidentStaysPanel bucket="past" />);
    const row = (await screen.findByText("Completed")).closest('[data-record-row]') as HTMLElement;
    fireEvent.click(within(row).getByText("Cedar Court · Attic Nook"));
    await waitFor(() => expect(document.querySelector('[data-attr="book-again-sheet"]')).toBeTruthy());
    await waitFor(() => expect(client.fetchBookableListing).toHaveBeenCalledWith("prop-1"));
    await waitFor(() => expect((document.querySelector('[data-attr="book-again-form"]') as HTMLElement | null)?.textContent).toContain("Attic Nook"));
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

describe("Book again sheet", () => {
  const open = async () => {
    const onBooked = vi.fn();
    render(<BookAgainSheet stays={stays} seed={base} onClose={vi.fn()} onBooked={onBooked} />);
    await waitFor(() => expect(document.querySelector('[data-attr="book-again-quick-tomorrow-1"]')).toBeTruthy());
    await waitFor(() => expect((document.querySelector('[data-attr="book-again-quick-tomorrow-1"]') as HTMLButtonElement).disabled).toBe(false));
    return onBooked;
  };
  const primary = () => document.querySelector('[data-attr="book-again-primary"]') as HTMLButtonElement;
  const quick = (id: string) => fireEvent.click(document.querySelector(`[data-attr="book-again-quick-${id}"]`)!);

  it("a quick pick fills the cart and the button says what the server's dry run decided", async () => {
    await open();
    expect(primary().textContent).toBe("Book");
    quick("tomorrow-1");
    expect(document.querySelector('[data-attr="book-again-cart"]')?.textContent).toContain("Oct 15 → Oct 16 · 1 night · $140");
    await waitFor(() => expect(primary().textContent).toBe("Confirm stay"));
    expect(client.postGuestStays).toHaveBeenCalledWith({ propertyId: "prop-1", roomId: "r1", guests: 1, ranges: [{ checkIn: "2026-10-15", checkOut: "2026-10-16" }], dryRun: true });
  });

  it("says Request to book when the server says the host decides", async () => {
    client.postGuestStays.mockResolvedValue(dry("request", "pending"));
    await open();
    quick("tomorrow-1");
    await waitFor(() => expect(primary().textContent).toBe("Request to book"));
  });

  it("crosses out taken nights and will not start a stay on one", async () => {
    await open();
    const taken = document.querySelector('[data-day="2026-10-21"]') as HTMLButtonElement;
    expect(taken.hasAttribute("data-taken")).toBe(true);
    expect(taken.className).toContain("line-through");
    expect(taken.disabled).toBe(true);
    expect((document.querySelector('[data-day="2026-10-22"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("Next week touches the taken night, so it is not added silently", async () => {
    await open();
    quick("next-week-3");
    expect(document.querySelector('[data-attr="book-again-cart"]')).toBeNull();
    expect(screen.getByText("Some of those nights are taken.")).toBeTruthy();
    expect((document.querySelector('[data-attr="book-again-add-stay"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("Add another stay stacks a second range from the calendar", async () => {
    await open();
    quick("tomorrow-1");
    fireEvent.click(document.querySelector('[data-day="2026-10-25"]')!);
    fireEvent.click(document.querySelector('[data-day="2026-10-27"]')!);
    fireEvent.click(document.querySelector('[data-attr="book-again-add-stay"]')!);
    const items = document.querySelectorAll('[data-attr="book-again-cart"] li');
    expect(items).toHaveLength(2);
    expect(items[1]!.textContent).toContain("Oct 25 → Oct 27 · 2 nights · $280");
  });

  it("a 409 race keeps the cart, marks the range and asks for other dates", async () => {
    await open();
    quick("tomorrow-1");
    await waitFor(() => expect(primary().textContent).toBe("Confirm stay"));
    const refused = [{ checkIn: "2026-10-15", checkOut: "2026-10-16", nights: 1, total: null, outcome: "unavailable", error: "That room was just booked for those dates." }];
    client.postGuestStays.mockRejectedValueOnce(new GuestStaysError("That room was just booked for those dates.", 409, refused as never));
    fireEvent.click(primary());
    expect(await screen.findByText("Someone just booked those nights. Pick other dates.")).toBeTruthy();
    expect(document.querySelector('[data-attr="book-again-cart"]')?.textContent).toContain("That room was just booked for those dates.");
    expect(document.querySelector('[data-attr="book-again-result"]')).toBeNull();
  });

  it("books, shows each outcome and tells the page to reload", async () => {
    const onBooked = await open();
    quick("tomorrow-1");
    await waitFor(() => expect(primary().textContent).toBe("Confirm stay"));
    client.postGuestStays.mockResolvedValueOnce({
      ok: true, dryRun: false, action: "confirm", summary: "1 confirmed",
      results: [{ checkIn: "2026-10-15", checkOut: "2026-10-16", nights: 1, total: 140, outcome: "confirmed", stayId: "b1" }],
    });
    fireEvent.click(primary());
    await waitFor(() => expect(document.querySelector('[data-attr="book-again-result"]')).toBeTruthy());
    expect(document.querySelector('[data-attr="book-again-result"]')?.textContent).toContain("1 confirmed");
    expect(document.querySelector('[data-attr="book-again-result"]')?.textContent).toContain("Oct 15 → Oct 16");
    expect(onBooked).toHaveBeenCalled();
    expect(primary().textContent).toBe("Done");
  });
});
