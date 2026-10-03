// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const save = vi.fn(async (_u: string, input: { id?: string }) => ({ ...input, id: input.id ?? "blk-new" }));
const del = vi.fn(async () => {});
vi.mock("@/lib/channel-calendar/room-date-blocks", () => ({
  ROOM_DATE_BLOCKS_CHANGED: "room-date-blocks-changed",
  fetchRoomDateBlocks: async () => [
    { id: "blk-1", propertyId: "p1", roomId: "r1", checkIn: "2026-11-01", checkOut: "2026-11-05", bookingStatus: "hold", reason: "Blocked by manager" },
  ],
  saveRoomDateBlock: (u: string, i: { id?: string }) => save(u, i),
  deleteRoomDateBlock: () => del(),
}));

import { BlockedDatesSection } from "@/components/portal/listing-room-editor/blocked-dates-section";

describe("Blocked dates rows (captain, Oct 3)", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    save.mockClear();
    del.mockClear();
  });

  it("each saved span is an editable row; editing saves the same block", async () => {
    render(<BlockedDatesSection propertyId="p1" roomId="r1" managerUserId="m1" />);
    const end = await screen.findByLabelText("End date, blocked span 1");
    fireEvent.change(end, { target: { value: "2026-11-09" } });
    await waitFor(() => expect(save).toHaveBeenCalledWith("m1", expect.objectContaining({ id: "blk-1", checkOut: "2026-11-09" })));
  });

  it("+ only adds an empty row; it saves once both dates are set", async () => {
    render(<BlockedDatesSection propertyId="p1" roomId="r1" managerUserId="m1" />);
    await screen.findByLabelText("Start date, blocked span 1");
    fireEvent.click(screen.getByRole("button", { name: "Add blocked dates" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Start date, blocked span 2"), { target: { value: "2026-12-01" } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("End date, blocked span 2"), { target: { value: "2026-12-03" } });
    await waitFor(() => expect(save).toHaveBeenCalledWith("m1", expect.objectContaining({ id: undefined, checkIn: "2026-12-01", checkOut: "2026-12-03" })));
  });
});
