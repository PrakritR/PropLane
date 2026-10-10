import { describe, expect, it, vi } from "vitest";

// A room block belongs to the house: the capacity trigger only accepts the property OWNER's id,
// so a co-manager's (or admin's) block is stamped to the owner — and only for someone who may
// edit that house's calendar.
const mocks = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  owner: "owner-1" as string | null,
  canWrite: false,
}));
vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: async () => mocks.owner }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: async () => mocks.canWrite }));
await import("@/app/api/portal-schedule-records/route");

type AtomicWrite = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const emptyDb = () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "or", "limit"]) builder[m] = () => builder;
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return { from: () => builder };
};
const block = (managerUserId: string | null) => ({
  id: "b1",
  record_type: "room_date_block",
  property_id: "p1",
  manager_user_id: managerUserId,
  row_data: { roomId: "r1", checkIn: "2099-01-01", checkOut: "2099-01-02", bookingStatus: "confirmed", reason: "Reserved" },
});
const write = (record: Record<string, unknown>, user: Record<string, unknown>) =>
  (mocks.config!.atomicWrite as AtomicWrite)({ db: emptyDb(), user, record, existing: null });

describe("room block ownership on save", () => {
  it("refuses a co-manager without Calendar edit on the house", async () => {
    mocks.canWrite = false;
    const result = await write(block("co-1"), { id: "co-1", role: "manager" });
    expect(result).toMatchObject({ handled: true, status: 403 });
  });
  it("stamps a co-manager's block to the owner and keeps who made it", async () => {
    mocks.canWrite = true;
    const record = block("co-1");
    const result = await write(record, { id: "co-1", role: "manager" });
    expect(result).toEqual({ handled: false });
    expect(record.manager_user_id).toBe("owner-1");
    expect((record.row_data as Record<string, unknown>).createdByUserId).toBe("co-1");
  });
  it("stamps an admin's unstamped block to the owner", async () => {
    mocks.canWrite = false;
    const record = block(null);
    expect(await write(record, { id: "admin-1", role: "admin" })).toEqual({ handled: false });
    expect(record.manager_user_id).toBe("owner-1");
  });
  it("leaves the owner's own block alone", async () => {
    const record = block("owner-1");
    expect(await write(record, { id: "owner-1", role: "manager" })).toEqual({ handled: false });
    expect((record.row_data as Record<string, unknown>).createdByUserId).toBeUndefined();
  });
});
