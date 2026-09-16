import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  replace: vi.fn(),
}));

vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({
  replaceManagerPlannedScheduleSlice: mocks.replace,
}));

await import("@/app/api/portal-schedule-records/route");

type AtomicWrite = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function plannedRecord(payload: Array<Record<string, unknown>>) {
  return {
    id: "axis_admin_planned_events_v1",
    row_data: { id: "axis_admin_planned_events_v1", payload },
  };
}

describe("planned schedule atomic route contract", () => {
  beforeEach(() => {
    mocks.replace.mockReset().mockResolvedValue({ available: true, ok: true, idempotent: false });
  });

  it("uses the manager's observed non-tour baseline and never forwards protected or tour rows", async () => {
    const atomicWrite = mocks.config!.atomicWrite as AtomicWrite;
    const ownTask = { id: "own-task", kind: "task", managerUserId: "manager-me", title: "Updated" };
    const newTask = { id: "new-task", kind: "task", title: "New" };
    const other = { id: "other", kind: "meeting", managerUserId: "manager-other", title: "Other" };
    const unassigned = { id: "legacy", kind: "meeting", title: "Legacy" };
    const tour = { id: "tour", kind: "tour", managerUserId: "manager-me", title: "Tour" };
    const existing = plannedRecord([other, unassigned, tour, { ...ownTask, title: "Old" }]);
    const expectedOwn = { id: "own-task", kind: "task", managerUserId: "manager-me", title: "Old" };

    await atomicWrite({
      db: {},
      user: { id: "manager-me", role: "manager" },
      record: plannedRecord([other, { ...unassigned, managerUserId: "manager-me", title: "Forged" }, tour, ownTask, newTask]),
      existing,
      expectedPayloadKnown: true,
      expectedPayload: [other, unassigned, tour, expectedOwn],
    });

    expect(mocks.replace).toHaveBeenCalledWith({}, {
      managerUserId: "manager-me",
      actorIsAdmin: false,
      events: [ownTask, { ...newTask, managerUserId: "manager-me" }],
      expectedEvents: [expectedOwn],
    });
  });

  it("fails closed without a browser-observed baseline and surfaces CAS conflicts", async () => {
    mocks.replace.mockResolvedValue({ available: true, ok: false, reason: "stale_schedule" });
    const atomicWrite = mocks.config!.atomicWrite as AtomicWrite;

    const result = await atomicWrite({
      db: {},
      user: { id: "manager-me", role: "manager" },
      record: plannedRecord([{ id: "task", kind: "task", managerUserId: "manager-me" }]),
      existing: plannedRecord([]),
      expectedPayloadKnown: false,
      expectedPayload: undefined,
    });

    expect(mocks.replace).toHaveBeenCalledWith({}, expect.objectContaining({ expectedEvents: null }));
    expect(result).toEqual({ handled: true, error: "stale_schedule", status: 409 });
  });

  it("lets an admin CAS-edit non-tour rows without adopting owners while preserving tours", async () => {
    const atomicWrite = mocks.config!.atomicWrite as AtomicWrite;
    const legacy = { id: "legacy", kind: "meeting", title: "Admin updated" };
    const owned = { id: "owned", kind: "task", managerUserId: "manager-other", title: "Owned updated" };
    const tour = { id: "tour", kind: "tour", managerUserId: "manager-other", title: "Tour forged" };

    await atomicWrite({
      db: {},
      user: { id: "admin-user", role: "admin" },
      record: plannedRecord([legacy, owned, tour]),
      existing: plannedRecord([legacy, owned, tour]),
      expectedPayloadKnown: true,
      expectedPayload: [
        { ...legacy, title: "Before" },
        { ...owned, title: "Before" },
        tour,
      ],
    });

    expect(mocks.replace).toHaveBeenCalledWith({}, {
      managerUserId: "admin-user",
      actorIsAdmin: true,
      events: [legacy, owned],
      expectedEvents: [
        { ...legacy, title: "Before" },
        { ...owned, title: "Before" },
      ],
    });
  });
});
