// @vitest-environment jsdom
/**
 * The guest's Check-in and checkout sheet, the Stays row that opens it, the text link that opens it
 * preselected, (bookings-times-1018, contract C; the arrival + add-on checkboxes of the booking application are in
 * resident-stay-request-ui.test.tsx). The network client is mocked; its routes have their own tests. An add-on the server does not
 * offer is never drawn; the Add button owns its loading and sends the guest to checkout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GuestStay } from "@/lib/short-stay/guest-stays";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/resident/applications/approved",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "u1", email: "priya@example.com", ready: true }) }));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({ useListingPublicOccupancy: () => ({ loading: false, rooms: [] }) }));
vi.mock("@/lib/room-availability-range", async (orig) => ({ ...(await orig<typeof import("@/lib/room-availability-range")>()), pacificTodayKey: () => "2026-10-14" }));

const client = vi.hoisted(() => ({
  fetchGuestStays: vi.fn(),
  fetchBookableListing: vi.fn(),
  postGuestStays: vi.fn(),
  fetchStayAddOns: vi.fn(),
  postStayAddOn: vi.fn(),
}));
vi.mock("@/lib/short-stay/guest-stays-client", async (orig) => ({ ...(await orig<typeof import("@/lib/short-stay/guest-stays-client")>()), ...client }));

import { StaysRowsHarness } from "../helpers/stays-rows-harness";
import { StayTimesSheet } from "@/components/portal/stay-times-sheet";
import { GuestStaysError, type StayAddOnsView } from "@/lib/short-stay/guest-stays-client";
import { stayAddOnRowViews } from "@/lib/short-stay/stay-add-ons";

const stay: GuestStay = {
  id: "s1", propertyId: "prop-1", roomId: "r1", propertyLabel: "Cedar Court", roomLabel: "Attic Nook",
  checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3, guests: 1, status: "confirmed", holdExpiresAt: null, total: 420, nightly: 140, canBookAgain: true,
  checkInTime: "15:00", checkOutTime: "11:00",
};

const early = { kind: "early_check_in", label: "Early check-in", offer: { kind: "early_check_in", available: true, time: "12:00", priceCents: 2500 }, record: null } as const;
const lateGone = { kind: "late_check_out", label: "Late checkout", offer: { kind: "late_check_out", available: false }, record: null } as const;
const view = (rows: unknown[], over: Record<string, unknown> = {}): StayAddOnsView =>
  ({ stay: { id: "s1", checkIn: "2026-10-20", checkOut: "2026-10-23", checkInTime: "15:00", checkOutTime: "11:00", estimatedArrival: null, status: "confirmed", ...over }, rows }) as StayAddOnsView;

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T20:00:00Z"));
  vi.clearAllMocks();
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, search: "" } });
  client.fetchGuestStays.mockResolvedValue([stay]);
  client.fetchStayAddOns.mockResolvedValue(view([early, lateGone]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the row view model (pure)", () => {
  it("hides what is unavailable, keeps what the guest already has", () => {
    const paid = { ...early, record: { time: "12:00", priceCents: 2500, status: "paid" } } as never;
    const pending = { ...lateGone, record: { time: "14:00", priceCents: 2500, status: "pending", chargeId: "hc" } } as never;
    expect(stayAddOnRowViews([early as never, lateGone as never])).toEqual([{ kind: "early_check_in", text: "Early check-in · 12:00 pm · $25", action: "add" }]);
    expect(stayAddOnRowViews([paid, lateGone as never])).toEqual([{ kind: "early_check_in", text: "Early check-in · 12:00 pm · Paid", action: null }]);
    expect(stayAddOnRowViews([early as never, pending])[1]).toEqual({ kind: "late_check_out", text: "Late checkout · 2:00 pm · $25", action: "pay" });
    expect(stayAddOnRowViews([{ ...early, offer: { kind: "early_check_in", available: false } } as never, lateGone as never])).toEqual([]);
  });
});

describe("Check-in and checkout sheet", () => {
  const open = async (props: Partial<Parameters<typeof StayTimesSheet>[0]> = {}) => {
    render(<StayTimesSheet stay={stay} onClose={vi.fn()} onChanged={vi.fn()} {...props} />);
    await waitFor(() => expect(document.querySelector('[data-attr="stay-times-body"]')).toBeTruthy());
  };

  it("shows the two times and one Add row for the add-on that is on offer; the unavailable one is not drawn", async () => {
    await open();
    const body = document.querySelector('[data-attr="stay-times-body"]')!.textContent!;
    expect(body).toContain("Check-in");
    expect(body).toContain("Oct 20, 3:00 pm");
    expect(body).toContain("Check-out");
    expect(body).toContain("Oct 23, 11:00 am");
    expect(document.querySelector('[data-attr="stay-add-on-early_check_in"]')?.textContent).toContain("Early check-in · 12:00 pm · $25");
    expect(document.querySelector('[data-attr="stay-add-on-late_check_out"]')).toBeNull();
    expect(screen.queryByText(/Late checkout/)).toBeNull();
  });

  it("when neither is available the sheet is just the two times", async () => {
    client.fetchStayAddOns.mockResolvedValue(view([{ ...early, offer: { kind: "early_check_in", available: false } }, lateGone]));
    await open();
    expect(document.querySelector('[data-attr="stay-add-on-rows"]')).toBeNull();
    expect(document.querySelector('[data-attr="stay-times-body"]')!.textContent).toContain("Oct 23, 11:00 am");
  });

  it("a paid add-on reads Paid and has no button", async () => {
    client.fetchStayAddOns.mockResolvedValue(view([{ ...early, record: { time: "12:00", priceCents: 2500, status: "paid" } }, lateGone], { checkInTime: "12:00" }));
    await open();
    const row = document.querySelector('[data-attr="stay-add-on-early_check_in"]')!;
    expect(row.textContent).toContain("Early check-in · 12:00 pm · Paid");
    expect(row.querySelector("button")).toBeNull();
    expect(document.querySelector('[data-attr="stay-times-body"]')!.textContent).toContain("Oct 20, 12:00 pm");
  });

  it("Add posts only the kind and the offered time, then sends the guest to checkout", async () => {
    client.postStayAddOn.mockResolvedValue({ status: "pending", kind: "early_check_in", time: "12:00", priceCents: 2500, chargeId: "hc_1", checkoutUrl: "https://checkout.stripe.test/c/1", paymentsPath: null });
    await open();
    fireEvent.click(document.querySelector('[data-attr="stay-add-on-early_check_in-add"]')!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/c/1"));
    expect(client.postStayAddOn).toHaveBeenCalledWith("s1", { kind: "early_check_in", time: "12:00" });
  });

  it("falls back to the Payments page when there is no hosted page, and a hold stays on the sheet as requested", async () => {
    client.postStayAddOn.mockResolvedValueOnce({ status: "pending", kind: "early_check_in", time: "12:00", priceCents: 2500, chargeId: "hc_1", checkoutUrl: null, paymentsPath: "/resident/payments" });
    await open();
    fireEvent.click(document.querySelector('[data-attr="stay-add-on-early_check_in-add"]')!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/resident/payments"));
  });

  it("says why when the server refuses (the slot went) and reloads the sheet", async () => {
    client.postStayAddOn.mockRejectedValueOnce(new GuestStaysError("Early check-in isn't available that day.", 409));
    await open();
    fireEvent.click(document.querySelector('[data-attr="stay-add-on-early_check_in-add"]')!);
    expect(await screen.findByText("Early check-in isn't available that day.")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(client.fetchStayAddOns).toHaveBeenCalledTimes(2);
  });

  it("a link's add-on is drawn selected and focused", async () => {
    await open({ preselect: { addOn: "early_check_in" } });
    expect(document.querySelector('[data-attr="stay-add-on-early_check_in"]')?.hasAttribute("data-selected")).toBe(true);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-attr")).toBe("stay-add-on-early_check_in-add"));
  });
});

describe("the Application page (short stays are rows)", () => {
  it("an approved stay row opens the Check-in times sheet from its ⋯ menu", async () => {
    render(<StaysRowsHarness section="approved" />);
    const row = (await screen.findByText("Cedar Court · Attic Nook")).closest('[data-record-row]') as HTMLElement;
    expect(row.textContent).toContain("Short stay · Oct 20–23 · 3 nights");
    fireEvent.keyDown(row.querySelector('[data-attr="record-actions-trigger"]')!, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Check-in times/ }));
    await waitFor(() => expect(document.querySelector('[data-attr="stay-times-sheet"]')).toBeTruthy());
    expect(client.fetchStayAddOns).toHaveBeenCalledWith("s1");
  });

  it("the text link (?stay=&addOn=&time=) opens that stay's sheet preselected", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, pathname: "/resident/applications/approved", search: "?stay=s1&addOn=early_check_in&time=12:00" } });
    render(<StaysRowsHarness section="approved" />);
    await waitFor(() => expect(document.querySelector('[data-attr="stay-times-sheet"]')).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[data-attr="stay-add-on-early_check_in"]')?.hasAttribute("data-selected")).toBe(true));
  });

  it("a link to someone else's stay opens nothing", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, pathname: "/resident/applications/approved", search: "?stay=not-mine&addOn=early_check_in" } });
    render(<StaysRowsHarness section="approved" />);
    await screen.findByText("Cedar Court · Attic Nook");
    expect(document.querySelector('[data-attr="stay-times-sheet"]')).toBeNull();
  });
});
