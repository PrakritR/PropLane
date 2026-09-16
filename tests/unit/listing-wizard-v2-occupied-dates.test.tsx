// @vitest-environment jsdom
//
// The Rooms step's Availability block, driven as a rendered component: a room is
// available by default, the round + adds an editable Start → End row, a dashed
// footer under the rows adds the next one, nothing about the renter-facing label
// is printed but every change still writes it beside the ranges, and the
// calendar switch stacks the month grid above the occupied from/until editors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OccupiedDates } from "@/components/portal/listing-wizard-v2/occupied-dates";
import { createDefaultListingSubmission, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/lib/channel-calendar/room-date-blocks", () => ({
  fetchRoomDateBlocks: async () => [],
}));
vi.mock("@/lib/rental-application/data", () => ({
  LISTING_ROOM_CHOICE_SEP: "::",
  getRoomUnavailabilityWindows: () => [],
}));

afterEach(() => cleanup());

function room(patch: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission {
  return { ...createDefaultListingSubmission().rooms[0]!, ...patch };
}

describe("OccupiedDates", () => {
  it("shows only the heading and the + with no rows — no readout word, no Renters see line", () => {
    const { container } = render(<OccupiedDates room={room()} propertyId={null} onRoom={() => {}} />);
    expect(screen.getByText("Availability")).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();
    expect(screen.queryByText(/Renters see/)).toBeNull();
    expect(screen.queryByText("Available now")).toBeNull();
    const add = screen.getByRole("button", { name: "Set occupied dates" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Add occupied dates" })).toBeNull();
    expect(screen.queryByLabelText("Occupied from")).toBeNull();
    expect(container.textContent).not.toContain("Occupied");
  });

  it("adds an open-ended row from today and writes Unavailable (occupied)", () => {
    const onRoom = vi.fn();
    render(<OccupiedDates room={room()} propertyId={null} onRoom={onRoom} />);
    fireEvent.click(screen.getByRole("button", { name: "Set occupied dates" }));
    expect(onRoom).toHaveBeenCalledTimes(1);
    const patch = onRoom.mock.calls[0]![0] as Partial<ManagerRoomSubmission>;
    expect(patch.manualUnavailableRanges).toHaveLength(1);
    expect(patch.manualUnavailableRanges![0]!.end).toBeNull();
    expect(patch.availability).toBe("Unavailable (occupied)");
    expect(patch.moveInAvailableDate).toBe("");
  });

  it("renders a stored row editable, flags End before Start, and removes on ✕", () => {
    const onRoom = vi.fn();
    const r = room({ manualUnavailableRanges: [{ id: "u1", start: "2026-09-01", end: "2026-10-31" }] });
    render(<OccupiedDates room={r} propertyId={null} onRoom={onRoom} />);
    expect((screen.getByLabelText("Occupied from") as HTMLInputElement).value).toBe("2026-09-01");
    expect((screen.getByLabelText("Occupied until") as HTMLInputElement).value).toBe("2026-10-31");

    fireEvent.change(screen.getByLabelText("Occupied until"), { target: { value: "2026-08-01" } });
    const edited = onRoom.mock.calls[0]![0] as Partial<ManagerRoomSubmission>;
    expect(edited.manualUnavailableRanges![0]!.end).toBe("2026-08-01");

    cleanup();
    render(<OccupiedDates room={room({ manualUnavailableRanges: [{ id: "u1", start: "2026-09-01", end: "2026-08-01" }] })} propertyId={null} onRoom={onRoom} />);
    expect(screen.getByText("End is before Start")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove these occupied dates" }));
    const removed = onRoom.mock.calls[onRoom.mock.calls.length - 1]![0] as Partial<ManagerRoomSubmission>;
    expect(removed.manualUnavailableRanges).toEqual([]);
    expect(removed.availability).toBe("Available now");
  });

  it("offers a dashed footer under the rows that adds the next range the day after the last End", () => {
    const onRoom = vi.fn();
    render(<OccupiedDates room={room({ manualUnavailableRanges: [{ id: "u1", start: "2099-01-01", end: "2099-01-31" }] })} propertyId={null} onRoom={onRoom} />);
    expect(screen.queryByText(/Renters see/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add occupied dates" }));
    const patch = onRoom.mock.calls[0]![0] as Partial<ManagerRoomSubmission>;
    expect(patch.manualUnavailableRanges).toHaveLength(2);
    expect(patch.manualUnavailableRanges![1]).toMatchObject({ start: "2099-02-01", end: null });
  });

  it("disables both adds while a row has no End", () => {
    render(<OccupiedDates room={room({ manualUnavailableRanges: [{ id: "u1", start: "2026-09-01", end: null }] })} propertyId={null} onRoom={() => {}} />);
    expect((screen.getByRole("button", { name: "Set occupied dates" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add occupied dates" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("flips on a labeled Calendar switch and keeps Occupied from/until on screen", () => {
    const today = new Date();
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const { container } = render(<OccupiedDates room={room({ manualUnavailableRanges: [{ id: "u1", start: key(today), end: key(today) }] })} propertyId={null} onRoom={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "Calendar" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const cell = container.querySelector(`[data-day="${key(today)}"]`);
    expect(cell?.getAttribute("data-tone")).toBe("occupied");
    expect(screen.getByLabelText("Occupied from")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByLabelText("Occupied from")).toBeTruthy();
  });

  it("paints occupied dates when the calendar drag commits an open range", () => {
    const onRoom = vi.fn();
    render(<OccupiedDates room={room()} propertyId={null} onRoom={onRoom} />);
    fireEvent.click(screen.getByRole("switch", { name: "Calendar" }));
    const cell = document.querySelector(`[data-tone="open"]`);
    expect(cell).toBeTruthy();
    const dayKey = cell!.getAttribute("data-day");
    fireEvent.pointerDown(cell!, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse" });
    expect(onRoom).toHaveBeenCalled();
    const patch = onRoom.mock.calls[0]![0] as Partial<ManagerRoomSubmission>;
    expect(patch.manualUnavailableRanges).toHaveLength(1);
    expect(patch.manualUnavailableRanges![0]).toMatchObject({ start: dayKey, end: dayKey });
  });

  it("shows a legacy future Available from as one occupied row and materializes it on edit", () => {
    const onRoom = vi.fn();
    const future = new Date();
    future.setDate(future.getDate() + 40);
    const key = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    render(<OccupiedDates room={room({ moveInAvailableDate: key })} propertyId={null} onRoom={onRoom} />);
    expect(screen.getByText("Occupied")).toBeTruthy(); // the row's pill, not a readout
    expect(screen.getByLabelText("Occupied from")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Occupied until"), { target: { value: key } });
    const patch = onRoom.mock.calls[0]![0] as Partial<ManagerRoomSubmission>;
    expect(patch.manualUnavailableRanges).toHaveLength(1);
    expect(patch.manualUnavailableRanges![0]!.id).not.toBe("legacy-available-from");
  });

  it("keeps Airbnb-imported ranges read-only and out of the editable rows", () => {
    const r = room({ manualUnavailableRanges: [{ id: "channel-import-c1-x", start: "2026-10-01", end: "2026-10-05" }] });
    render(<OccupiedDates room={r} propertyId={null} onRoom={() => {}} />);
    expect(screen.getByText("Airbnb")).toBeTruthy();
    expect(screen.queryByLabelText("Occupied from")).toBeNull();
  });
});
