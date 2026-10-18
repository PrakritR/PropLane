// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: () => undefined,
    getRoomOptionsForProperty: (propertyId: string) => (propertyId === "prop-a" ? [{ value: "prop-a::room-1", label: "Room 1" }, { value: "prop-a::room-2", label: "Room 2" }] : []),
  };
});

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
});
afterEach(() => { cleanup(); document.body.style.pointerEvents = ""; });

import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { Modal, clearStaleBodyPointerLock } from "@/components/ui/modal";
import { canCancelBooking, canDeleteReservation } from "@/lib/channel-calendar/booking-presentation";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDays, dateKey } from "@/lib/room-availability-calendar";

const TODAY = new Date(2026, 8, 10);
const key = (offset: number) => dateKey(addDays(TODAY, offset));
function entry(overrides: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry {
  return { source: "block", propertyId: "prop-a", propertyLabel: "Prop A House", roomId: "room-1", roomLabel: "Room 1", summary: "Reserved", start: key(3), end: key(4), blockId: "b1", bookingStatus: "confirmed", ...overrides };
}

describe("a menu item that opens a modal does not leave the page dead", () => {
  it("clears a stale body pointer-events lock once the modal closes and no layer is open", async () => {
    // A modal Radix DropdownMenu sets body pointer-events:none; a Dialog mounted while that lock is on captures
    // "none" as the body's original value and restores it on close. (Mounting both layers at once loops in jsdom's
    // focus handling, so the menu's lock is stood in for directly.)
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => { document.body.style.pointerEvents = "none"; setOpen(true); }}>Edit</button>
        <Modal open={open} title="Edit thing" onClose={() => setOpen(false)}>Body</Modal>
      </>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Body");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByText("Body")).toBeNull());
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(""), { timeout: 1500 });
  });
  it("leaves the lock alone while another dialog or menu layer is still open", async () => {
    document.body.style.pointerEvents = "none";
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    document.body.appendChild(menu);
    clearStaleBodyPointerLock();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(document.body.style.pointerEvents).toBe("none");
    menu.remove();
    clearStaleBodyPointerLock();
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(""), { timeout: 1500 });
  });
});

describe("canDeleteReservation", () => {
  it("is true for a marked reservation at any date, past and open-ended included", () => {
    expect(canDeleteReservation(entry())).toBe(true);
    expect(canDeleteReservation(entry({ start: "2000-01-01", end: "2000-01-03" }))).toBe(true);
    expect(canDeleteReservation(entry({ openEnded: true, end: "9999-12-30" }))).toBe(true);
    expect(canCancelBooking(entry({ start: "2000-01-01", end: "2000-01-03" }), "2026-09-10")).toBe(false);
  });
  it("is false for a named hold, a channel stay, a lease, an already cancelled block and a block with no id", () => {
    expect(canDeleteReservation(entry({ residentName: "Maya" }))).toBe(false);
    expect(canDeleteReservation(entry({ source: "airbnb", blockId: undefined, connectionId: "c", sourceUid: "u" }))).toBe(false);
    expect(canDeleteReservation(entry({ source: "proplane", blockId: undefined }))).toBe(false);
    expect(canDeleteReservation(entry({ bookingStatus: "cancelled" }))).toBe(false);
    expect(canDeleteReservation(entry({ blockId: undefined }))).toBe(false);
  });
});

describe("the bar popover", () => {
  // Production's Unblock / Delete live in the popover (`bookingRemovalActions`); this branch's part is that it is non-modal.
  function openPopover(entries: PropertyBookingEntry[], handlers: Record<string, unknown> = { onDeleteBlock: () => {}, onUnblockBooking: () => {} }) {
    render(<BookingsPortfolioTimeline propertyIds={["prop-a"]} entries={entries} today={TODAY} onEditBooking={() => {}} {...handlers} />);
    const bar = document.querySelector('[data-attr="bookings-calendar-bar"]') as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, ctrlKey: false });
  }
  it("offers Delete for marked-reserved dates and leaves the page unlocked", async () => {
    openPopover([entry()]);
    await screen.findByRole("menuitem", { name: "Delete" });
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(document.querySelector('[data-testid="dropdown-menu-backdrop"]')).toBeNull();
  });
  it("calls onDeleteBlock with the entry", async () => {
    const onDeleteBlock = vi.fn();
    openPopover([entry()], { onDeleteBlock });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(onDeleteBlock).toHaveBeenCalledWith(expect.objectContaining({ blockId: "b1" }));
  });
  it("offers neither Delete nor Unblock for a channel stay or a lease", async () => {
    openPopover([entry({ source: "airbnb", blockId: undefined, connectionId: "c", sourceUid: "u", summary: "Airbnb (Not available)" })]);
    await screen.findByRole("menuitem", { name: "Open booking" });
    expect(screen.queryByRole("menuitem", { name: /^(Delete|Unblock)$/ })).toBeNull();
    cleanup();
    openPopover([entry({ source: "proplane", blockId: undefined, residentName: "Jordan" })]);
    await screen.findByRole("menuitem", { name: "Open booking" });
    expect(screen.queryByRole("menuitem", { name: /^(Delete|Unblock)$/ })).toBeNull();
  });
});

describe("the Edit sheet", () => {
  const wrap = (node: React.ReactNode) => render(<AppUiProvider>{node}</AppUiProvider>);
  it("shows only Where, When and Label for a reservation, with no Guest, Rate or Status and no native select", () => {
    wrap(<BookingsEditSheet entry={entry()} entries={[entry()]} onClose={() => {}} onSave={vi.fn()} onDelete={() => {}} />);
    expect(screen.getByText("Edit reservation")).toBeTruthy();
    for (const section of ["where", "when", "label"]) expect(document.querySelector(`[data-section="${section}"]`)).toBeTruthy();
    for (const section of ["guest", "rate", "details"]) expect(document.querySelector(`[data-section="${section}"]`)).toBeNull();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText(/^Rate/)).toBeNull();
    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete reservation" })).toBeTruthy();
  });
  it("a named block adds Guest, Rate and Stay details, still with no native select", () => {
    wrap(<BookingsEditSheet entry={entry({ residentName: "Maya", summary: "Maya", start: "2099-01-01", end: "2099-01-05" })} entries={[]} onClose={() => {}} onSave={vi.fn()} onDelete={() => {}} />);
    expect(screen.getByText("Edit booking")).toBeTruthy();
    for (const section of ["guest", "where", "when", "rate", "details"]) expect(document.querySelector(`[data-section="${section}"]`)).toBeTruthy();
    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel booking" })).toBeTruthy();
  });
  it("moving to an overlapping room disables Save and names the overlap", async () => {
    const other = entry({ blockId: "b2", roomId: "room-2", roomLabel: "Room 2", residentName: "Jordan", summary: "Jordan" });
    const mine = entry({ residentName: "Maya", summary: "Maya" });
    wrap(<BookingsEditSheet entry={mine} entries={[mine, other]} onClose={() => {}} onSave={vi.fn()} />);
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(false);
    fireEvent.click(document.querySelector('[data-attr="select-booking-edit-room"]') as HTMLElement);
    const option = (await screen.findAllByRole("option")).find((node) => /Room 2/.test(node.textContent ?? ""))!;
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Room 2 is booked/));
    expect(save().disabled).toBe(true);
  });
  it("saves a reservation as a reservation: no resident, no rate", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    wrap(<BookingsEditSheet entry={entry({ reason: "Reserved" })} entries={[entry()]} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByDisplayValue("Reserved"), { target: { value: "Owner stay" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "b1", residentName: "", reason: "Owner stay", bookingStatus: "confirmed", rate: undefined })));
  });
  it("new content on dates with nobody attached needs a reason (Closed) or a guest name", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    wrap(<BookingsEditSheet entry={entry({ reason: "" })} entries={[entry()]} onClose={() => {}} onSave={onSave} />);
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    // A stored row written before this rule (no reason) is still editable while its name, kind and
    // reason are left alone - the same exemption the route and the assistant tool apply. The rule
    // arbitrates what the manager TYPES here.
    expect(save().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Airbnb" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Painting" } });
    expect(save().disabled).toBe(false);
    await act(async () => { fireEvent.click(save()); });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "b1", residentName: "", reason: "Painting", blockKind: "closed" })));
  });
  it("naming the guest on a reservation saves a named booking, not a closed room", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    wrap(<BookingsEditSheet entry={entry({ reason: "" })} entries={[entry()]} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Guest name"), { target: { value: "Maya Chen" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const draft = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(draft).toMatchObject({ residentName: "Maya Chen" });
    expect(draft).not.toHaveProperty("blockKind");
  });
  it("editing the Guest name, email and phone on a named block saves them, and a blank name cannot be saved", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const named = entry({ residentName: "Maya", summary: "Maya", residentEmail: "maya@example.test", start: "2099-01-01", end: "2099-01-05" });
    wrap(<BookingsEditSheet entry={named} entries={[named]} onClose={() => {}} onSave={onSave} />);
    expect(document.querySelector("select")).toBeNull();
    const name = screen.getByDisplayValue("Maya");
    fireEvent.change(name, { target: { value: "Maya Chen" } });
    fireEvent.change(screen.getByDisplayValue("maya@example.test"), { target: { value: "maya.chen@example.test" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "b1", residentName: "Maya Chen", residentEmail: "maya.chen@example.test" })));
    cleanup();
    wrap(<BookingsEditSheet entry={named} entries={[named]} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByDisplayValue("Maya"), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("an invited resident's Name, Email and Phone are read-only; a plain named hold's are editable", () => {
    const base = entry({ residentName: "Maya", summary: "Maya", residentEmail: "maya@example.test", start: "2099-01-01", end: "2099-01-05" });
    wrap(<BookingsEditSheet entry={{ ...base, isBookingResidency: true }} entries={[base]} onClose={() => {}} onSave={vi.fn()} />);
    expect((screen.getByDisplayValue("Maya") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByDisplayValue("maya@example.test") as HTMLInputElement).disabled).toBe(true);
    expect((document.querySelector('[data-attr="booking-edit-phone-number"]') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    wrap(<BookingsEditSheet entry={base} entries={[base]} onClose={() => {}} onSave={vi.fn()} />);
    expect((screen.getByDisplayValue("Maya") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByDisplayValue("maya@example.test") as HTMLInputElement).disabled).toBe(false);
    expect((document.querySelector('[data-attr="booking-edit-phone-number"]') as HTMLInputElement).disabled).toBe(false);
  });
});
