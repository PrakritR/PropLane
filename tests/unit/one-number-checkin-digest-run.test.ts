import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ alert: vi.fn(), entries: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/one-number/ops-alerts.server", () => ({ alertPhonesOf: mocks.alert }));
vi.mock("@/lib/occupancy/snapshot.server", () => ({ occupancyEntriesForManager: mocks.entries }));
vi.mock("@/lib/service/service-manager.server", () => ({ readServiceManagerSettings: mocks.service }));
vi.mock("@/lib/bookings/property-stay-times.server", () => ({
  loadPropertyStayClock: async () => ({ times: { checkInTime: "15:00", checkOutTime: "11:00" }, timeZone: "America/Los_Angeles" }),
}));

import { runCheckinCheckoutDigest } from "@/lib/one-number/checkin-digest.server";

function fakeDb() {
  const tables: Record<string, unknown[]> = {
    workspace_work_number_recipients: [{ owner_user_id: "owner-1" }, { owner_user_id: "owner-1" }],
    manager_property_records: [{ id: "p1" }, { id: "p2" }],
    portal_workspaces: [],
  };
  const chain = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.limit = () => Promise.resolve({ data: rows, error: null });
    return q;
  };
  return { from: (name: string) => chain(tables[name] ?? []) } as never;
}

// 2026-11-04 15:00Z = 7 AM PST; 16:00Z = 8 AM PST.
const SEVEN = () => new Date("2026-11-04T15:00:00Z");
const EIGHT = () => new Date("2026-11-04T16:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.alert.mockResolvedValue({ texted: 1, emailed: 0 });
  mocks.service.mockResolvedValue(null);
  mocks.entries.mockResolvedValue({
    entries: [
      { source: "airbnb", propertyId: "p1", propertyLabel: "4709A", roomId: "r4", roomLabel: "Room 4", summary: "Anthony", start: "2026-11-04", end: "2026-11-06" },
      { source: "airbnb", propertyId: "p2", propertyLabel: "5259", roomId: "r1", roomLabel: "Room 1", summary: "Sam", start: "2026-11-20", end: "2026-11-21" },
    ],
  });
});

describe("runCheckinCheckoutDigest", () => {
  it("acts only at 7 AM Pacific, and texts one line per house that has something, keyed by house and date", async () => {
    expect((await runCheckinCheckoutDigest(fakeDb(), { now: EIGHT })).skippedReason).toBe("not_7am");
    expect(mocks.alert).not.toHaveBeenCalled();
    const out = await runCheckinCheckoutDigest(fakeDb(), { now: SEVEN });
    expect(out).toMatchObject({ owners: 1, houses: 1, sent: 1, failed: 0 });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![1]).toMatchObject({
      ownerUserId: "owner-1",
      kind: "checkin_checkout_today",
      entityId: "p1:2026-11-04",
      propertyId: "p1",
      text: "Today 4709A — check-in Room 4 (Anthony, Airbnb, 3 PM).",
    });
  });

  it("one owner's unreadable houses never stop the run", async () => {
    mocks.entries.mockRejectedValueOnce(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCheckinCheckoutDigest(fakeDb(), { now: SEVEN })).toMatchObject({ failed: 1, sent: 0 });
    spy.mockRestore();
  });
});
