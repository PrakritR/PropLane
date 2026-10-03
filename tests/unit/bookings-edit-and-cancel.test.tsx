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
    render(<AppUiProvider><BookingsCancelDialog entry={entry} onClose={() => {}} onSave={onSave} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[0][0]).toMatchObject({ bookingStatus: "cancelled", isBookingResidency: true });
    expect(onSave.mock.calls[1][0]).toMatchObject({ bookingStatus: "confirmed", residentEmail: entry.residentEmail, residentPhone: entry.residentPhone, isBookingResidency: true, rate: 45, rateBasis: "daily", reason: "A note", stayDetails: entry.stayDetails });
  });
});
