// @vitest-environment jsdom
/**
 * The short-stay booking APPLICATION (`/resident/stays/request`): prefilled from the public card's link,
 * built like the long-term application (Stay, Guests, About the stay, Review), always a request (no Quick book,
 * no instant confirm), and submitted with the answers and the house-rules agreement. The network client is
 * mocked; its route has its own tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/resident/stays/request",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "u1", email: "priya@example.com", ready: true }) }));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ loading: false, rooms: [{ roomChoice: "prop-1::r1", spans: [{ start: "2026-10-21", end: "2026-10-21", count: 1 }] }] }),
}));
vi.mock("@/lib/room-availability-range", async (orig) => ({ ...(await orig<typeof import("@/lib/room-availability-range")>()), pacificTodayKey: () => "2026-10-14" }));

const client = vi.hoisted(() => ({ fetchBookableListing: vi.fn(), postGuestStays: vi.fn() }));
vi.mock("@/lib/short-stay/guest-stays-client", async (orig) => ({ ...(await orig<typeof import("@/lib/short-stay/guest-stays-client")>()), ...client }));

import { ResidentStayRequest } from "@/components/portal/resident-stay-request";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { GuestStaysError } from "@/lib/short-stay/guest-stays-client";
import { parseStayRequestPrefill, stayRequestHref } from "@/lib/short-stay/stay-request-link";

const listing = {
  propertyId: "prop-1", propertyLabel: "Cedar Court", confirmsInstantly: true, guestName: "Priya Natarajan",
  houseRules: "Quiet after 10 pm.", shortStayRequirements: "",
  rooms: [{ id: "r1", label: "Attic Nook", nightly: 140, sleeps: 1 }, { id: "r4", label: "Garden Suite", nightly: 90, sleeps: 4 }],
  stayTimes: { checkInTime: "15:00", checkOutTime: "11:00", earliestEarlyCheckIn: "12:00", latestLateCheckOut: "14:00", earlyCheckInPriceCents: 2500, lateCheckOutPriceCents: 2500 },
};
const dry = (outcome = "pending", addOns: unknown[] = []) => ({
  ok: true, dryRun: true, action: "request", summary: "",
  results: [{ checkIn: "2026-10-22", checkOut: "2026-10-24", nights: 2, total: 280, outcome, addOns }],
});
const prefill = { listing: "prop-1", room: "r4", checkIn: "2026-10-22", checkOut: "2026-10-24", guests: 2 };

const mount = (over: Partial<typeof prefill> = {}) =>
  render(<AppUiProvider><ResidentStayRequest prefill={{ ...prefill, ...over }} /></AppUiProvider>);
const next = async () => {
  const button = document.querySelector('[data-attr="stay-request-next"]') as HTMLButtonElement;
  await waitFor(() => expect(button.getAttribute("aria-disabled")).not.toBe("true"));
  fireEvent.click(button);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T20:00:00Z"));
  vi.clearAllMocks();
  client.fetchBookableListing.mockResolvedValue(listing);
  client.postGuestStays.mockResolvedValue(dry());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the request link", () => {
  it("builds and parses the portal address the public card links to", () => {
    const href = stayRequestHref({ listing: "prop-1", room: "r4", checkIn: "2026-10-22", checkOut: "2026-10-24", guests: 2 });
    expect(href).toBe("/resident/stays/request?listing=prop-1&room=r4&checkIn=2026-10-22&checkOut=2026-10-24&guests=2");
    const params = Object.fromEntries(new URL(href, "https://x.test").searchParams);
    expect(parseStayRequestPrefill(params)).toEqual({ listing: "prop-1", room: "r4", checkIn: "2026-10-22", checkOut: "2026-10-24", guests: 2 });
    // Garbage is dropped, never trusted.
    expect(parseStayRequestPrefill({ listing: "p", checkIn: "tomorrow", guests: "x" })).toMatchObject({ listing: "p", checkIn: "", guests: 1 });
  });
});

describe("the booking application", () => {
  it("opens on Stay with the room, dates and guests from the link and a live total", async () => {
    mount();
    await waitFor(() => expect(document.querySelector('[data-attr="stay-request-room"]')).toBeTruthy());
    expect(document.body.textContent).toContain("Garden Suite");
    expect(document.querySelector('[data-attr="stay-request-guests"]')?.textContent).toBe("2");
    expect(document.body.textContent).toContain("Oct 22");
    await waitFor(() => expect(client.postGuestStays).toHaveBeenCalledWith({ propertyId: "prop-1", roomId: "r4", guests: 2, ranges: [{ checkIn: "2026-10-22", checkOut: "2026-10-24" }], dryRun: true }));
    expect(document.body.textContent).toContain("$180");
    expect(document.querySelector('[data-attr="stay-request-standard-times"]')?.textContent).toBe("Check-in 3:00 pm · Check-out 11:00 am");
    // There is no Quick book and no instant confirm wording anywhere on the page.
    expect(document.body.textContent).not.toMatch(/Quick book|Confirm stay|instantly/i);
  });

  it("says so when the home takes no short stays, with a way to find a room", async () => {
    client.fetchBookableListing.mockResolvedValue(null);
    mount();
    expect(await screen.findByText("This home doesn't take short stays right now.")).toBeTruthy();
    expect(document.querySelector('[data-attr="stay-request-find-room"]')).toBeTruthy();
  });

  it("holds Next on a night that is taken, and shows why", async () => {
    mount({ room: "r1", guests: 1, checkIn: "2026-10-20", checkOut: "2026-10-23" });
    await waitFor(() => expect(document.querySelector('[data-attr="stay-request-dates-problem"]')).toBeTruthy());
    expect(document.querySelector('[data-attr="stay-request-dates-problem"]')?.textContent).toBe("Some of those nights are taken.");
    expect((document.querySelector('[data-attr="stay-request-next"]') as HTMLButtonElement).getAttribute("aria-disabled")).toBe("true");
  });

  it("walks Stay, Guests, About the stay, Review and submits the answers with source = the session (no id in the body)", async () => {
    mount();
    await waitFor(() => expect(client.postGuestStays).toHaveBeenCalled());
    await next();
    // Guests: the account holder is the session, everyone else is named.
    expect(await screen.findByText("Priya Natarajan")).toBeTruthy();
    fireEvent.change(document.querySelector('[data-attr="stay-request-guest-name-2"]')!, { target: { value: "Sam Lee" } });
    await next();
    // About the stay: the agreement is required.
    expect(document.querySelector('[data-attr="stay-request-rules-text"]')?.textContent).toBe("Quiet after 10 pm.");
    expect((document.querySelector('[data-attr="stay-request-next"]') as HTMLButtonElement).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(document.querySelector('[data-attr="stay-request-purpose"] button, [data-attr="stay-request-purpose"]')!);
    fireEvent.click(await screen.findByRole("option", { name: "Work or business" }));
    fireEvent.change(document.querySelector('[data-attr="stay-request-message"]')!, { target: { value: "Landing at 9 pm." } });
    fireEvent.click(document.querySelector('[data-attr="stay-request-rules-agree"]')!);
    await next();
    const review = document.querySelector('[data-attr="stay-request-review"]')!;
    expect(review.textContent).toContain("Sam Lee");
    expect(review.textContent).toContain("Work or business");
    expect(review.textContent).toContain("Agreed");

    client.postGuestStays.mockResolvedValueOnce({ ok: true, dryRun: false, action: "request", summary: "1 pending", results: [{ outcome: "pending" }] });
    const finish = document.querySelector('[data-attr="stay-request-finish"]') as HTMLButtonElement;
    expect(finish.textContent).toContain("Request to book");
    fireEvent.click(finish);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/resident/stays/upcoming", { replace: true }));
    expect(client.postGuestStays).toHaveBeenLastCalledWith({
      propertyId: "prop-1", roomId: "r4", guests: 2, ranges: [{ checkIn: "2026-10-22", checkOut: "2026-10-24" }],
      application: { purpose: "work", message: "Landing at 9 pm.", guestNames: ["Sam Lee"], rulesAgreed: true },
    });
  });

  it("a 409 race sends the guest back to Stay with a plain message", async () => {
    mount({ guests: 1, room: "r1", checkIn: "2026-10-23", checkOut: "2026-10-24" });
    client.postGuestStays.mockResolvedValue(dry());
    await waitFor(() => expect(client.postGuestStays).toHaveBeenCalled());
    await next();
    await next();
    fireEvent.click(document.querySelector('[data-attr="stay-request-purpose"] button, [data-attr="stay-request-purpose"]')!);
    fireEvent.click(await screen.findByRole("option", { name: "Travel or vacation" }));
    fireEvent.click(document.querySelector('[data-attr="stay-request-rules-agree"]')!);
    await next();
    client.postGuestStays.mockRejectedValueOnce(new GuestStaysError("That room was just booked for those dates.", 409));
    fireEvent.click(document.querySelector('[data-attr="stay-request-finish"]')!);
    await waitFor(() => expect(navigate).not.toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('[data-attr="stay-request-room"]')).toBeTruthy());
  });

  it("draws an add-on only when the server's dry run offers it, adds it to the total and sends it with the request", async () => {
    client.postGuestStays.mockResolvedValue(dry("pending", [{ kind: "early_check_in", available: true, time: "12:00", priceCents: 2500 }, { kind: "late_check_out", available: false }]));
    mount({ room: "r1", guests: 1 });
    const box = (await screen.findByLabelText("Early check-in")) as HTMLInputElement;
    expect(document.querySelector('[data-attr="stay-request-add-on-late_check_out"]')).toBeNull();
    expect(document.querySelector('[data-attr="stay-request-add-on-early_check_in"]')?.textContent).toContain("Early check-in · 12:00 pm · $25");
    fireEvent.click(box);
    await waitFor(() => expect(document.body.textContent).toContain("$305"));
  });
});
