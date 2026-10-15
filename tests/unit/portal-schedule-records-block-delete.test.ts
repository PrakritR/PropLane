/**
 * Unblock then Delete a room block (docs/agents/bookings.md § Blocks): cancelling an ended block stays
 * a 409, a cancelled or ended block can still be hard-deleted, and a teammate without Calendar edit on
 * the house is refused on both. The route is the shared JSON-record route; its hooks are driven directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  canWrite: vi.fn(),
}));

vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({ replaceManagerPlannedScheduleSlice: vi.fn() }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: mocks.canWrite }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn().mockResolvedValue(null) }));

await import("@/app/api/portal-schedule-records/route");

type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const atomicWrite = () => mocks.config!.atomicWrite as Hook;
const authorizeDelete = () => mocks.config!.authorizeDelete as Hook;

const dayKey = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
const stored = (recordType: string, checkIn: string, checkOut: string) => ({
  id: "room_block_owner-1_abc",
  record_type: recordType,
  manager_user_id: "owner-1",
  property_id: "prop-1",
  row_data: { checkIn, checkOut, roomId: "r1", reason: "Closed" },
});
const cancelBody = (existing: Record<string, unknown>) => ({ ...existing, record_type: "cancelled_room_date_block" });

describe("cancel (Unblock) and delete of a room block", () => {
  beforeEach(() => { mocks.canWrite.mockReset().mockResolvedValue(false); });
  const owner = { id: "owner-1", role: "manager" };

  it("cancelling a live block is allowed", async () => {
    const existing = stored("room_date_block", dayKey(1), dayKey(4));
    expect(await atomicWrite()({ db: {}, user: owner, record: cancelBody(existing), existing })).toEqual({ handled: false });
  });

  it("cancelling an ended block is still a 409", async () => {
    const existing = stored("room_date_block", dayKey(-9), dayKey(-6));
    const result = await atomicWrite()({ db: {}, user: owner, record: cancelBody(existing), existing });
    expect(result).toMatchObject({ handled: true, status: 409 });
  });

  it("the owner can hard-delete a cancelled block and an ended block", async () => {
    for (const record of [stored("cancelled_room_date_block", dayKey(1), dayKey(4)), stored("room_date_block", dayKey(-9), dayKey(-6))]) {
      expect(await authorizeDelete()({ db: {}, user: owner, records: [record] })).toEqual({ ok: true });
    }
  });

  it("a teammate without Calendar edit on the house is refused on both the cancel and the delete", async () => {
    const teammate = { id: "mate-1", role: "manager" };
    const live = stored("room_date_block", dayKey(1), dayKey(4));
    const cancelled = stored("cancelled_room_date_block", dayKey(1), dayKey(4));
    expect(await atomicWrite()({ db: {}, user: teammate, record: cancelBody(live), existing: live })).toMatchObject({ handled: true, status: 403 });
    expect(await authorizeDelete()({ db: {}, user: teammate, records: [cancelled] })).toMatchObject({ ok: false, status: 403 });
  });

  it("a teammate with Calendar edit may delete", async () => {
    mocks.canWrite.mockResolvedValue(true);
    const cancelled = stored("cancelled_room_date_block", dayKey(1), dayKey(4));
    expect(await authorizeDelete()({ db: {}, user: { id: "mate-1", role: "manager" }, records: [cancelled] })).toEqual({ ok: true });
  });
});
