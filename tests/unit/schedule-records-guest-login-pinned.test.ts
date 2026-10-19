import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: null as null | Record<string, unknown> }));

vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));

await import("@/app/api/portal-schedule-records/route");

type AtomicWrite = (input: Record<string, unknown>) => Promise<unknown>;

function block(rowData: Record<string, unknown>) {
  return {
    id: "blk_1",
    record_type: "room_date_block",
    property_id: "",
    manager_user_id: "owner-1",
    row_data: { propertyId: "", roomId: "r1", checkIn: "2026-11-02", checkOut: "2026-11-05", residentName: "Brandi", ...rowData },
  };
}

// The guest's login drives the stay charge, the guest's Stays page and the arrival-guide text (door
// code included), so a manager save through this route never sets or moves it.
describe("portal-schedule-records: a stay's guest login is server-owned", () => {
  it("keeps the stored guest when an edit names another account", async () => {
    const atomicWrite = mocks.config!.atomicWrite as AtomicWrite;
    const record = block({ residentUserId: "someone-else" });
    await atomicWrite({ db: {}, user: { id: "owner-1", role: "manager" }, record, existing: block({ residentUserId: "guest-1" }) });
    expect((record.row_data as Record<string, unknown>).residentUserId).toBe("guest-1");
  });

  it("drops a guest login a manager tries to put on a stay that has none", async () => {
    const atomicWrite = mocks.config!.atomicWrite as AtomicWrite;
    const record = block({ residentUserId: "someone-else" });
    await atomicWrite({ db: {}, user: { id: "owner-1", role: "manager" }, record, existing: block({}) });
    expect(record.row_data).not.toHaveProperty("residentUserId");
  });

  it("drops it on a new booking too", async () => {
    const atomicWrite = mocks.config!.atomicWrite as AtomicWrite;
    const record = block({ residentUserId: "someone-else" });
    await atomicWrite({ db: {}, user: { id: "owner-1", role: "manager" }, record, existing: null }).catch(() => undefined);
    expect(record.row_data).not.toHaveProperty("residentUserId");
  });
});
