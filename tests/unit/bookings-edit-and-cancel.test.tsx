// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import { BookingsCancelDialog } from "@/components/portal/bookings-cancel-dialog";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
const entry: PropertyBookingEntry = { source: "block", propertyId: "house", propertyLabel: "House", roomId: "room", roomLabel: "Room", summary: "Guest", residentName: "Guest", residentEmail: "guest@example.test", residentPhone: "+12065550199", isBookingResidency: true, blockId: "block-1", start: "2099-01-01", end: "2099-01-05", rate: 45, rateBasis: "daily", bookingStatus: "confirmed", reason: "A note", stayDetails: { linen: "Delivered", baggage: "Yes" } };
afterEach(cleanup);
describe("booking edit and undo", () => {
  it("disables Save for a negative rate and preserves an open-ended save", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<AppUiProvider><BookingsEditSheet entry={entry} entries={[entry]} onClose={() => {}} onSave={onSave} /></AppUiProvider>);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-1" } });
    expect((screen.getByRole("button", { name: "Save booking" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("switch", { name: "Open-ended" }));
    fireEvent.click(screen.getByRole("button", { name: "Save booking" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ openEnded: true, rate: 60, isBookingResidency: true, stayDetails: entry.stayDetails })));
  });
  it("disables signed-lease edit controls and has no save action", () => {
    const view = render(<AppUiProvider><BookingsEditSheet entry={{ ...entry, source: "proplane", blockId: undefined }} entries={[]} onClose={() => {}} onSave={vi.fn()} /></AppUiProvider>);
    expect(screen.queryByRole("button", { name: "Save booking" })).toBeNull();
    for (const input of view.container.querySelectorAll("input")) expect(input.disabled).toBe(true);
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
  });
  it("Undo restores source metadata, residency, rate and original status", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<AppUiProvider><BookingsCancelDialog entry={entry} onClose={() => {}} onSave={onSave} notify={vi.fn().mockResolvedValue({ ok: true })} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[0][0]).toMatchObject({ bookingStatus: "cancelled", isBookingResidency: true });
    expect(onSave.mock.calls[1][0]).toMatchObject({ bookingStatus: "confirmed", residentEmail: entry.residentEmail, residentPhone: entry.residentPhone, isBookingResidency: true, rate: 45, rateBasis: "daily", reason: "A note", stayDetails: entry.stayDetails });
  });
  it("Notify guest is on by default, sends through the notice sender only after the cancel is saved, and the toast says so", async () => {
    const order: string[] = [];
    const onSave = vi.fn().mockImplementation(async () => { order.push("save"); });
    const notify = vi.fn().mockImplementation(async () => { order.push("notify"); return { ok: true }; });
    render(<AppUiProvider><BookingsCancelDialog entry={entry} onClose={() => {}} onSave={onSave} notify={notify} /></AppUiProvider>);
    expect((screen.getByRole("checkbox", { name: "Notify guest" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(screen.getByText(/guest notified/)).toBeTruthy());
    expect(order).toEqual(["save", "notify"]);
    expect(notify).toHaveBeenCalledWith(entry);
  });
  it("unchecking Notify guest cancels without sending anything", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    render(<AppUiProvider><BookingsCancelDialog entry={entry} onClose={() => {}} onSave={onSave} notify={notify} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("checkbox", { name: "Notify guest" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    expect(notify).not.toHaveBeenCalled();
  });
  it("a failed notice never undoes the cancel and is reported", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue({ ok: false, error: "No recipient" });
    render(<AppUiProvider><BookingsCancelDialog entry={entry} onClose={() => {}} onSave={onSave} notify={notify} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(screen.getByText(/guest not notified: No recipient/)).toBeTruthy());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it("with no email on file Notify guest is disabled and unchecked, with no explanation text", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const noEmail = { ...entry, residentEmail: undefined };
    render(<AppUiProvider><BookingsCancelDialog entry={noEmail} onClose={() => {}} onSave={onSave} notify={notify} /></AppUiProvider>);
    const box = screen.getByRole("checkbox", { name: "Notify guest" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(screen.queryByText(/unavailable|no email/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(notify).not.toHaveBeenCalled();
  });
  it("a signed-lease stay edits notes and stay details through the stay-meta save, with property, room, dates and rate locked", async () => {
    const onSave = vi.fn();
    const onSaveStayMeta = vi.fn().mockResolvedValue(undefined);
    const signed: PropertyBookingEntry = { ...entry, source: "proplane", blockId: undefined, leaseId: "lease-9", bookingStatus: undefined, reason: "Old note" };
    const view = render(<AppUiProvider><BookingsEditSheet entry={signed} entries={[]} onClose={() => {}} onSave={onSave} onSaveStayMeta={onSaveStayMeta} /></AppUiProvider>);
    const triggers = Array.from(view.baseElement.querySelectorAll<HTMLButtonElement>("button[aria-haspopup]"));
    // Property, Room, Status and Source are locked; Linen and Baggage are editable housekeeping.
    expect(triggers.filter((trigger) => trigger.disabled).length).toBeGreaterThanOrEqual(4);
    expect(triggers.filter((trigger) => !trigger.disabled).length).toBe(2);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
    const notes = screen.getByDisplayValue("Old note") as HTMLInputElement;
    expect(notes.disabled).toBe(false);
    fireEvent.change(notes, { target: { value: "Gate code 4411" } });
    fireEvent.click(screen.getByRole("button", { name: "Save booking" }));
    await waitFor(() => expect(onSaveStayMeta).toHaveBeenCalledWith({ kind: "lease", refId: "lease-9", notes: "Gate code 4411", stayDetails: { linen: "Delivered", baggage: "Yes" } }));
    expect(onSave).not.toHaveBeenCalled();
  });
  it("a channel feed stay stays read-only even when the stay-meta save is offered", () => {
    const channel: PropertyBookingEntry = { ...entry, source: "airbnb", blockId: undefined, connectionId: "c1", sourceUid: "u1" };
    render(<AppUiProvider><BookingsEditSheet entry={channel} entries={[]} onClose={() => {}} onSave={vi.fn()} onSaveStayMeta={vi.fn()} /></AppUiProvider>);
    expect(screen.queryByRole("button", { name: "Save booking" })).toBeNull();
  });
});
