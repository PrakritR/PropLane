// @vitest-environment jsdom
/**
 * Unblock and Delete (Oct 14 2026): which removal actions a calendar bar and the record page offer,
 * per kind of booking, and the "Blocked" word for a live block. docs/agents/bookings.md § Blocks.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import { bookingRemovalActions, bookingStatusLabel } from "@/lib/channel-calendar/booking-presentation";
import { bookingRowStatusFact } from "@/components/portal/manager-bookings-list-view";
import { addDays, dateKey } from "@/lib/room-availability-calendar";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return { ...actual, getPropertyById: () => undefined, getRoomOptionsForProperty: (id: string) => (id === "prop-a" ? [{ value: "prop-a::room-1", label: "Room 1" }] : []) };
});

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
});
afterEach(() => { cleanup(); navigate.mockClear(); localStorage.clear(); });

const TODAY = new Date(2026, 8, 10);
const TODAY_KEY = dateKey(TODAY);
const base: PropertyBookingEntry = { source: "block", propertyId: "prop-a", propertyLabel: "Prop A House", roomId: "room-1", roomLabel: "Room 1", summary: "Closed", start: dateKey(addDays(TODAY, 1)), end: dateKey(addDays(TODAY, 3)), blockId: "block-1", reason: "Closed", bookingStatus: "hold" };
const nativeLive = base;
const nativeCancelled: PropertyBookingEntry = { ...base, bookingStatus: "cancelled" };
const nativeEnded: PropertyBookingEntry = { ...base, start: dateKey(addDays(TODAY, -9)), end: dateKey(addDays(TODAY, -6)) };
const channel: PropertyBookingEntry = { ...base, source: "airbnb", blockId: undefined, bookingStatus: undefined, connectionId: "c1", sourceUid: "u1", summary: "Airbnb guest" };
const resident: PropertyBookingEntry = { ...base, source: "proplane", blockId: undefined, leaseId: "lease-1", bookingStatus: undefined, summary: "Ada Lovelace", residentName: "Ada Lovelace" };

describe("bookingRemovalActions: one gate for the bar and the record", () => {
  it("native live: Unblock and Delete", () => {
    expect(bookingRemovalActions(nativeLive, TODAY_KEY)).toEqual({ unblock: true, deleteBlock: true, unblockChannel: false });
  });
  it("native cancelled or ended: Delete only (already free)", () => {
    expect(bookingRemovalActions(nativeCancelled, TODAY_KEY)).toEqual({ unblock: false, deleteBlock: true, unblockChannel: false });
    expect(bookingRemovalActions(nativeEnded, TODAY_KEY)).toEqual({ unblock: false, deleteBlock: true, unblockChannel: false });
  });
  it("an imported channel bar: Unblock in PropLane (tombstone), never Delete", () => {
    expect(bookingRemovalActions(channel, TODAY_KEY)).toEqual({ unblock: false, deleteBlock: false, unblockChannel: true });
  });
  it("a resident stay: neither", () => {
    expect(bookingRemovalActions(resident, TODAY_KEY)).toEqual({ unblock: false, deleteBlock: false, unblockChannel: false });
  });
});

describe("the Blocked label", () => {
  it("a live block with nobody attached is Blocked; Cancelled only once cancelled", () => {
    expect(bookingStatusLabel(nativeLive, TODAY_KEY)).toBe("Blocked");
    expect(bookingStatusLabel(nativeCancelled, TODAY_KEY)).toBe("Cancelled");
  });
  it("a resident (approved application) reads In-house / Confirmed / Checked out, never Hold, with or without applicationId", () => {
    const resident: PropertyBookingEntry = { ...base, source: "hold", blockId: undefined, bookingStatus: undefined, residentName: "Ada", start: dateKey(addDays(TODAY, -2)), end: dateKey(addDays(TODAY, 5)) };
    expect(bookingStatusLabel(resident, TODAY_KEY)).toBe("In-house");
    expect(bookingStatusLabel({ ...resident, applicationId: "app-1" }, TODAY_KEY)).toBe("In-house");
    expect(bookingStatusLabel({ ...resident, start: dateKey(addDays(TODAY, 2)), end: dateKey(addDays(TODAY, 9)) }, TODAY_KEY)).toBe("Confirmed");
    expect(bookingStatusLabel({ ...resident, start: dateKey(addDays(TODAY, -9)), end: dateKey(addDays(TODAY, -2)) }, TODAY_KEY)).toBe("Checked out");
  });
  it("a block held for a named person stays Hold, a confirmed one Confirmed", () => {
    expect(bookingStatusLabel({ ...nativeLive, residentName: "Dee" }, TODAY_KEY)).toBe("Hold");
    expect(bookingStatusLabel({ ...nativeLive, bookingStatus: "confirmed" }, TODAY_KEY)).toBe("Confirmed");
  });
  it("a list row prints the same word, so a closed room reads Blocked there too and not a guest's Hold", () => {
    expect(bookingRowStatusFact(nativeLive, TODAY_KEY)).toBe("Blocked");
    expect(bookingRowStatusFact({ ...nativeLive, residentName: "Dee" }, TODAY_KEY)).toBe("Hold");
  });
});

function openBar() {
  const bar = document.querySelector('[data-attr="bookings-calendar-bar"]')!;
  fireEvent.keyDown(bar, { key: "ArrowDown" });
  return document.body.querySelector('[role="menu"]')!;
}
function bar(entry: PropertyBookingEntry) {
  const handlers = { onEditBooking: vi.fn(), onUnblockBooking: vi.fn(), onDeleteBlock: vi.fn(), onUnblockChannelStay: vi.fn() };
  render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[entry]} today={TODAY} {...handlers} />);
  return { ...handlers, menu: openBar() };
}

describe("calendar bar popover", () => {
  it("native live block: Edit, Unblock, Delete, Open booking, and each fires its handler with the entry", () => {
    const { menu, onUnblockBooking, onDeleteBlock, onUnblockChannelStay } = bar(nativeLive);
    expect(menu.textContent).toMatch(/Edit.*Unblock.*Delete.*Open booking/);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unblock" }));
    expect(onUnblockBooking).toHaveBeenCalledWith(nativeLive);
    expect(onDeleteBlock).not.toHaveBeenCalled();
    expect(onUnblockChannelStay).not.toHaveBeenCalled();
  });
  it("Delete hands the entry to the delete handler", () => {
    const { onDeleteBlock } = bar(nativeLive);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDeleteBlock).toHaveBeenCalledWith(nativeLive);
  });
  it("an ended native block offers Delete but not Unblock", () => {
    const { menu } = bar({ ...nativeEnded, start: dateKey(addDays(TODAY, -2)), end: dateKey(addDays(TODAY, -1)) });
    expect(screen.queryByRole("menuitem", { name: "Unblock" })).toBeNull();
    expect(menu.textContent).toContain("Delete");
  });
  it("an imported bar offers Unblock in PropLane and no Delete", () => {
    const { menu, onUnblockChannelStay } = bar(channel);
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unblock" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unblock in PropLane" }));
    expect(onUnblockChannelStay).toHaveBeenCalledWith(channel);
    expect(menu).toBeTruthy();
  });
  it("a resident stay offers neither", () => {
    const { menu } = bar(resident);
    expect(menu.textContent).not.toMatch(/Unblock|Delete/);
  });
  it("with no handlers wired (a viewer who cannot edit) nothing is offered", () => {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={[nativeLive]} today={TODAY} />);
    expect(openBar().textContent).not.toMatch(/Unblock|Delete/);
  });
  it("the bar's record link is the same row the record page opens", () => {
    bar(nativeLive);
    const link = screen.getByRole("menuitem", { name: /Open booking/ }).getAttribute("href")!;
    expect(decodeURIComponent(link)).toContain(bookingEntryKey(nativeLive));
    expect(bookingEntryKey(nativeLive)).toBe("block:block-1");
  });
});

const noop = async () => {};
// The record page reads the real clock, so its live block is dated from now.
const now = new Date();
const liveNow: PropertyBookingEntry = { ...nativeLive, start: dateKey(addDays(now, 1)), end: dateKey(addDays(now, 3)) };
function page(entry: PropertyBookingEntry, props: Partial<React.ComponentProps<typeof BookingsRecordPage>> = {}) {
  return render(<AppUiProvider><BookingsRecordPage bookingId={bookingEntryKey(entry)} basePath="/portal" entries={[entry]} loading={false} residentOptions={[]} onSaveBlock={noop} onRemoveBlock={noop} showToast={() => {}} {...props} /></AppUiProvider>);
}
/** The header's icon actions, sorted (the row draws the filled primary last). */
const headerIds = () => [...document.querySelectorAll('[data-attr^="record-header-action-"]')].map((node) => node.getAttribute("data-attr")!.replace("record-header-action-", "")).sort();

describe("record page header", () => {
  it("native live block: Message, Edit, Unblock, Delete as icons, no ⋯ anywhere, status Blocked", () => {
    page(liveNow);
    expect(headerIds()).toEqual(["delete", "edit", "message", "unblock"]);
    expect(document.querySelector('[aria-label*="More"], [data-attr*="more"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    expect(screen.getByText("Blocked")).toBeTruthy();
  });
  it("Unblock opens the cancel dialog with Undo", async () => {
    const onSaveBlock = vi.fn().mockResolvedValue(undefined);
    page(liveNow, { onSaveBlock });
    fireEvent.click(document.querySelector('[data-attr="record-header-action-unblock"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    expect(onSaveBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-1", bookingStatus: "cancelled" }));
  });
  it("Delete asks first, hard-deletes through onRemoveBlock, then returns to the list", async () => {
    const onRemoveBlock = vi.fn().mockResolvedValue(true);
    page(liveNow, { onRemoveBlock });
    fireEvent.click(document.querySelector('[data-attr="record-header-action-delete"]')!);
    expect(onRemoveBlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onRemoveBlock).toHaveBeenCalledWith("block-1"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/bookings")));
  });
  it("a failed delete stays on the record", async () => {
    const onRemoveBlock = vi.fn().mockResolvedValue(false);
    page(liveNow, { onRemoveBlock });
    fireEvent.click(document.querySelector('[data-attr="record-header-action-delete"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onRemoveBlock).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });
  it("a cancelled block says Cancelled and offers Delete but no Unblock", () => {
    page(nativeCancelled);
    expect(headerIds()).toEqual(["delete", "edit", "message"]);
    expect(screen.getByText("Cancelled")).toBeTruthy();
  });
  it("an imported stay: Edit (notes and money), and Delete is labelled Remove from PropLane and opens the tombstone remover", () => {
    page(channel);
    expect(headerIds()).toEqual(["delete", "edit", "message"]);
    expect(document.querySelector('[data-attr="record-header-action-delete"]')!.getAttribute("aria-label")).toBe("Remove from PropLane");
    fireEvent.click(document.querySelector('[data-attr="record-header-action-delete"]')!);
    expect(document.querySelector('[data-attr="bookings-remove-stay-dialog"]')).toBeTruthy();
  });
  it("a resident stay offers neither Unblock nor Delete", () => {
    page(resident);
    expect(headerIds()).not.toContain("unblock");
    expect(headerIds()).not.toContain("delete");
  });
});
