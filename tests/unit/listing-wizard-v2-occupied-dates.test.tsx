// @vitest-environment jsdom
//
// The Rooms step's Availability block, driven as a rendered component: a room is
// available by default, "Set occupied dates" adds an editable Start → End row,
// the readout and the renter-facing label derive from the rows, and every
// change writes the derived fields beside the ranges.
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
  it("reads Available with no rows and offers the occupied button", () => {
    render(<OccupiedDates room={room()} propertyId={null} onRoom={() => {}} />);
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Available now")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set occupied dates" })).toBeTruthy();
    expect(screen.queryByLabelText("Occupied from")).toBeNull();
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

  it("shows a legacy future Available from as one occupied row and materializes it on edit", () => {
    const onRoom = vi.fn();
    const future = new Date();
    future.setDate(future.getDate() + 40);
    const key = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    const { container } = render(<OccupiedDates room={room({ moveInAvailableDate: key })} propertyId={null} onRoom={onRoom} />);
    expect(container.querySelector('[data-attr="listing-v2-room-availability-readout"]')?.textContent).toBe("Occupied");
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
