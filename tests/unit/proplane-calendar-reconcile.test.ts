import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `pullProplaneCalendarPendingChanges` / `resolvePendingGoogleCalendarChange`
 * — the two-way half that never existed before: a PropLane-owned tour or
 * service visit that was edited or deleted on Google must become an
 * explicit attention item, never a silent reschedule/cancel.
 */

const mocks = vi.hoisted(() => ({
  listGoogleCalendarWriteEventsForSync: vi.fn(),
  isGoogleCalendarNotLinkedError: vi.fn(() => false),
  loadGoogleCalendarConnection: vi.fn(),
  saveGoogleCalendarConnection: vi.fn(async () => undefined),
  mutateConfirmedTourSchedule: vi.fn(),
  deletePlannedTourByGoogleCalendarEventId: vi.fn(async () => true),
  syncPlannedTourToGoogleCalendar: vi.fn(async () => "gcal-1"),
  syncWorkOrderToGoogleCalendar: vi.fn(async (row: unknown) => row),
}));

vi.mock("@/lib/google-calendar/api.server", () => ({
  listGoogleCalendarWriteEventsForSync: mocks.listGoogleCalendarWriteEventsForSync,
  isGoogleCalendarNotLinkedError: mocks.isGoogleCalendarNotLinkedError,
}));
vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: mocks.loadGoogleCalendarConnection,
  saveGoogleCalendarConnection: mocks.saveGoogleCalendarConnection,
}));
vi.mock("@/lib/tour-schedule-persistence.server", () => ({
  mutateConfirmedTourSchedule: mocks.mutateConfirmedTourSchedule,
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  SERVICE_VISIT_DURATION_MINUTES: 60,
  deletePlannedTourByGoogleCalendarEventId: mocks.deletePlannedTourByGoogleCalendarEventId,
  syncPlannedTourToGoogleCalendar: mocks.syncPlannedTourToGoogleCalendar,
  syncWorkOrderToGoogleCalendar: mocks.syncWorkOrderToGoogleCalendar,
}));

import {
  pullProplaneCalendarPendingChanges,
  listPendingGoogleCalendarChanges,
  resolvePendingGoogleCalendarChange,
} from "@/lib/google-calendar/proplane-calendar-reconcile.server";

/** A minimal chainable fake matching exactly the query-builder calls this module makes. */
function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    order: () => obj,
    limit: () => obj,
    upsert: (...args: unknown[]) => {
      recorded.push({ op: "upsert", args });
      return Promise.resolve(result);
    },
    update: (...args: unknown[]) => {
      recorded.push({ op: "update", args });
      return obj;
    },
    delete: (...args: unknown[]) => {
      recorded.push({ op: "delete", args });
      return obj;
    },
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

let recorded: Array<{ op: string; args: unknown[] }>;
let tableResponses: Record<string, unknown>;

function makeDb() {
  return {
    from: vi.fn((table: string) => chain(tableResponses[table])),
  };
}

const tourRow = (overrides: Record<string, unknown> = {}) => ({
  id: "planned-1",
  title: "Tour with Jane",
  start: "2099-01-01T17:00:00.000Z",
  end: "2099-01-01T17:30:00.000Z",
  googleCalendarEventId: "gcal-1",
  ...overrides,
});

describe("pullProplaneCalendarPendingChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recorded = [];
    tableResponses = {};
    mocks.saveGoogleCalendarConnection.mockResolvedValue(undefined);
  });

  it("reports no_write_calendar and does nothing when there is no dedicated calendar yet", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true, syncEnabled: true, proplaneSyncToken: null });
    mocks.listGoogleCalendarWriteEventsForSync.mockResolvedValue({
      events: [],
      syncTokenInvalid: false,
      truncated: false,
      noWriteCalendar: true,
    });
    const db = makeDb();
    const result = await pullProplaneCalendarPendingChanges(db as never, "manager-1", "manager");
    expect(result).toEqual({ ok: true, pending: 0, resolvedAutomatically: 0, reason: "no_write_calendar" });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("records a time_changed pending row when Google's time disagrees with the PropLane record", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true, syncEnabled: true, proplaneSyncToken: null });
    mocks.listGoogleCalendarWriteEventsForSync.mockResolvedValue({
      events: [
        {
          id: "gcal-1",
          status: "confirmed",
          summary: "Tour with Jane",
          description: "Created from PropPlane\nType: tour",
          start: "2099-01-01T18:00:00.000Z",
          end: "2099-01-01T18:30:00.000Z",
        },
      ],
      syncTokenInvalid: false,
      truncated: false,
      nextSyncToken: "token-2",
    });
    tableResponses = {
      portal_schedule_records: { data: { row_data: { payload: [tourRow()] } } },
      google_calendar_pending_changes: { error: null },
    };
    const db = makeDb();
    const result = await pullProplaneCalendarPendingChanges(db as never, "manager-1", "manager");
    expect(result.ok).toBe(true);
    expect(result.pending).toBe(1);
    const upsertCall = recorded.find((r) => r.op === "upsert");
    expect(upsertCall).toBeDefined();
    const row = upsertCall!.args[0] as Record<string, unknown>;
    expect(row.change_type).toBe("time_changed");
    expect(row.proposed_start).toBe("2099-01-01T18:00:00.000Z");
    expect(row.previous_start).toBe("2099-01-01T17:00:00.000Z");
    expect(mocks.saveGoogleCalendarConnection).toHaveBeenCalledWith(db, "manager-1", { proplaneSyncToken: "token-2" });
  });

  it("records a deleted pending row for a cancelled PropLane-owned event", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true, syncEnabled: true, proplaneSyncToken: "tok" });
    mocks.listGoogleCalendarWriteEventsForSync.mockResolvedValue({
      events: [{ id: "gcal-1", status: "cancelled", summary: "" }],
      syncTokenInvalid: false,
      truncated: false,
    });
    tableResponses = {
      portal_schedule_records: { data: { row_data: { payload: [tourRow()] } } },
      google_calendar_pending_changes: { error: null },
    };
    const db = makeDb();
    const result = await pullProplaneCalendarPendingChanges(db as never, "manager-1", "manager");
    expect(result.pending).toBe(1);
    const upsertCall = recorded.find((r) => r.op === "upsert");
    expect((upsertCall!.args[0] as Record<string, unknown>).change_type).toBe("deleted");
  });

  it("skips a non-PropLane event on the write calendar entirely", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true, syncEnabled: true, proplaneSyncToken: null });
    mocks.listGoogleCalendarWriteEventsForSync.mockResolvedValue({
      events: [{ id: "manual-event", status: "confirmed", summary: "Dentist", start: "x", end: "y" }],
      syncTokenInvalid: false,
      truncated: false,
    });
    const db = makeDb();
    const result = await pullProplaneCalendarPendingChanges(db as never, "manager-1", "manager");
    expect(result.pending).toBe(0);
    expect(db.from).not.toHaveBeenCalledWith("portal_schedule_records");
  });

  it("clears a previously-pending row once Google's time matches the PropLane record again", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true, syncEnabled: true, proplaneSyncToken: null });
    mocks.listGoogleCalendarWriteEventsForSync.mockResolvedValue({
      events: [
        {
          id: "gcal-1",
          status: "confirmed",
          summary: "Tour with Jane",
          description: "Created from PropPlane\nType: tour",
          start: "2099-01-01T17:00:00.000Z",
          end: "2099-01-01T17:30:00.000Z",
        },
      ],
      syncTokenInvalid: false,
      truncated: false,
    });
    tableResponses = {
      portal_schedule_records: { data: { row_data: { payload: [tourRow()] } } },
      google_calendar_pending_changes: { error: null, count: 1 },
    };
    const db = makeDb();
    const result = await pullProplaneCalendarPendingChanges(db as never, "manager-1", "manager");
    expect(result.resolvedAutomatically).toBe(1);
    expect(recorded.some((r) => r.op === "delete")).toBe(true);
  });
});

describe("listPendingGoogleCalendarChanges", () => {
  it("maps db rows to the public shape", async () => {
    const db = makeDb();
    tableResponses = {
      google_calendar_pending_changes: {
        data: [
          {
            id: "axis_gcal_pending_manager-1_gcal-1",
            owner_user_id: "manager-1",
            owner_kind: "manager",
            record_kind: "tour",
            record_id: "planned-1",
            google_calendar_event_id: "gcal-1",
            change_type: "time_changed",
            summary: "Tour with Jane",
            previous_start: "a",
            previous_end: "b",
            proposed_start: "c",
            proposed_end: "d",
            status: "pending",
            created_at: "2099-01-01T00:00:00.000Z",
            updated_at: "2099-01-01T00:00:00.000Z",
          },
        ],
      },
    };
    const rows = await listPendingGoogleCalendarChanges(db as never, "manager-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "axis_gcal_pending_manager-1_gcal-1", changeType: "time_changed", recordKind: "tour" });
  });
});

describe("resolvePendingGoogleCalendarChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recorded = [];
  });

  it("accept applies Google's proposed time through the guarded replace boundary", async () => {
    const pendingRow = {
      id: "axis_gcal_pending_manager-1_gcal-1",
      owner_user_id: "manager-1",
      owner_kind: "manager",
      record_kind: "tour",
      record_id: "planned-1",
      google_calendar_event_id: "gcal-1",
      change_type: "time_changed",
      summary: "Tour with Jane",
      previous_start: "2099-01-01T17:00:00.000Z",
      previous_end: "2099-01-01T17:30:00.000Z",
      proposed_start: "2099-01-01T18:00:00.000Z",
      proposed_end: "2099-01-01T18:30:00.000Z",
      status: "pending",
      created_at: "2099-01-01T00:00:00.000Z",
      updated_at: "2099-01-01T00:00:00.000Z",
    };
    tableResponses = {
      google_calendar_pending_changes: { data: pendingRow, error: null },
      portal_schedule_records: { data: { row_data: { payload: [tourRow()] } } },
    };
    mocks.mutateConfirmedTourSchedule.mockResolvedValue({ ok: true });
    const db = makeDb();

    const result = await resolvePendingGoogleCalendarChange(db as never, "manager-1", pendingRow.id, "accept");
    expect(result).toEqual({ ok: true });
    expect(mocks.mutateConfirmedTourSchedule).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        operation: "replace",
        event: expect.objectContaining({ start: "2099-01-01T18:00:00.000Z", end: "2099-01-01T18:30:00.000Z" }),
        expected: expect.objectContaining({ start: "2099-01-01T17:00:00.000Z", end: "2099-01-01T17:30:00.000Z" }),
      }),
    );
    expect(recorded.some((r) => r.op === "update")).toBe(true);
  });

  it("dismiss re-pushes PropLane's own version back onto Google", async () => {
    const pendingRow = {
      id: "axis_gcal_pending_manager-1_gcal-1",
      owner_user_id: "manager-1",
      owner_kind: "manager",
      record_kind: "tour",
      record_id: "planned-1",
      google_calendar_event_id: "gcal-1",
      change_type: "time_changed",
      summary: "Tour with Jane",
      previous_start: "2099-01-01T17:00:00.000Z",
      previous_end: "2099-01-01T17:30:00.000Z",
      proposed_start: "2099-01-01T18:00:00.000Z",
      proposed_end: "2099-01-01T18:30:00.000Z",
      status: "pending",
      created_at: "x",
      updated_at: "x",
    };
    tableResponses = {
      google_calendar_pending_changes: { data: pendingRow, error: null },
      portal_schedule_records: { data: { row_data: { payload: [tourRow()] } } },
    };
    const db = makeDb();

    const result = await resolvePendingGoogleCalendarChange(db as never, "manager-1", pendingRow.id, "dismiss");
    expect(result).toEqual({ ok: true });
    expect(mocks.syncPlannedTourToGoogleCalendar).toHaveBeenCalledWith(
      db,
      "manager-1",
      expect.objectContaining({
        plannedEventId: "planned-1",
        start: "2099-01-01T17:00:00.000Z",
        end: "2099-01-01T17:30:00.000Z",
        googleCalendarEventId: "gcal-1",
      }),
    );
  });

  it("returns not_found for an id that is not pending (already resolved, or someone else's)", async () => {
    tableResponses = { google_calendar_pending_changes: { data: null, error: null } };
    const db = makeDb();
    const result = await resolvePendingGoogleCalendarChange(db as never, "manager-1", "missing-id", "accept");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
