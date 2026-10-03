// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveRoomDateBlock, fetchRoomDateBlocks } from "@/lib/channel-calendar/room-date-blocks";
import { bookingConflictsFor, roomBlockEntries } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey, classifyBookingListBucket } from "@/lib/channel-calendar/bookings-ui";
import { managerScheduleRecordIdOwnedByUser, isManagerScopedScheduleRecordType } from "@/lib/portal-schedule-record-scope";
const draft = { id: "axis_room_block_manager_1", propertyId: "house", roomId: "room", checkIn: "2026-11-01", checkOut: "2026-11-06", reason: "", residentName: "Taylor", isBookingResidency: true };
afterEach(() => vi.unstubAllGlobals());
describe("booking cancellation archive", () => {
  it("writes a separate non-occupying record type and restores the same id", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetcher);
    await saveRoomDateBlock("manager", { ...draft, bookingStatus: "cancelled" });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).row).toMatchObject({ id: draft.id, recordType: "cancelled_room_date_block", isBookingResidency: true });
    await saveRoomDateBlock("manager", { ...draft, bookingStatus: "confirmed" });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).row).toMatchObject({ id: draft.id, recordType: "room_date_block", bookingStatus: "confirmed" });
  });
  it("reads cancelled records into Past with stable identity and no conflict", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [{ ...draft, recordType: "cancelled_room_date_block" }] }) }));
    const blocks = await fetchRoomDateBlocks();
    const [entry] = roomBlockEntries(blocks, { propertyLabelForId: () => "House", roomLabelForId: () => "Room" });
    expect(classifyBookingListBucket(entry, "2026-10-01")).toBe("past");
    expect(bookingConflictsFor([entry], entry)).toEqual([]);
    expect(bookingEntryKey({ ...entry, start: "2027-01-01", roomId: "other" })).toBe(bookingEntryKey(entry));
  });
  it("scopes the archive to the same authenticated manager", () => {
    expect(isManagerScopedScheduleRecordType("cancelled_room_date_block")).toBe(true);
    expect(managerScheduleRecordIdOwnedByUser(draft.id, "manager", "cancelled_room_date_block")).toBe(true);
    expect(managerScheduleRecordIdOwnedByUser(draft.id, "other", "cancelled_room_date_block")).toBe(false);
  });
  it("stores an indefinite range while bounding its calendar drawing", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetcher);
    const block = await saveRoomDateBlock("manager", { ...draft, openEnded: true });
    expect(block.checkOut).toBe("9999-12-31");
    const [entry] = roomBlockEntries([block], { propertyLabelForId: () => "House", roomLabelForId: () => "Room" });
    expect(entry.openEnded).toBe(true);
    expect(entry.end < "9999-01-01").toBe(true);
    expect(bookingConflictsFor([entry], { ...entry, start: "2099-01-01", end: "2099-01-03" })).toHaveLength(1);
  });
});
