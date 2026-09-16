import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mergeTourAvailabilitySlotsIntoWindows, slotStartMs } from "@/lib/tour-slot-math";

// Far enough in the future that "now" filtering never makes these flaky.
const FUTURE_DATE = "2030-01-07"; // a Monday

describe("mergeTourAvailabilitySlotsIntoWindows", () => {
  const now = 0; // slots below are all far after epoch 0, so nothing is filtered as "past"

  it("merges back-to-back slots into one window", () => {
    const windows = mergeTourAvailabilitySlotsIntoWindows(
      [`${FUTURE_DATE}:18`, `${FUTURE_DATE}:19`, `${FUTURE_DATE}:20`],
      now,
    );
    expect(windows).toHaveLength(1);
    expect(Date.parse(windows[0]!.start)).toBe(slotStartMs(`${FUTURE_DATE}:18`));
    // Three consecutive half-hour slots span 1.5 hours.
    expect(Date.parse(windows[0]!.end) - Date.parse(windows[0]!.start)).toBe(90 * 60 * 1000);
  });

  it("keeps non-adjacent slots as separate windows", () => {
    const windows = mergeTourAvailabilitySlotsIntoWindows([`${FUTURE_DATE}:18`, `${FUTURE_DATE}:30`], now);
    expect(windows).toHaveLength(2);
  });

  it("merges across a real midnight boundary (slot 47 ends exactly when the next day's slot 0 begins)", () => {
    const nextDate = "2030-01-08";
    const windows = mergeTourAvailabilitySlotsIntoWindows([`${FUTURE_DATE}:47`, `${nextDate}:0`], now);
    expect(windows).toHaveLength(1);
    expect(Date.parse(windows[0]!.end) - Date.parse(windows[0]!.start)).toBe(60 * 60 * 1000);
  });

  it("does not merge slots that are NOT truly back-to-back (a gap of even one slot)", () => {
    // Slot 20 ends at the same instant slot 21 would start — skipping straight
    // to 22 leaves a real 30-minute gap, so this must stay two windows.
    const windows = mergeTourAvailabilitySlotsIntoWindows([`${FUTURE_DATE}:20`, `${FUTURE_DATE}:22`], now);
    expect(windows).toHaveLength(2);
  });

  it("drops past slots and default-exclusion markers", () => {
    // "now" is pinned past FUTURE_DATE itself, so every slot below is either
    // an exclusion marker (never a published slot) or in the past relative
    // to this cutoff.
    const afterFutureDate = Date.parse("2031-01-01T00:00:00Z");
    const windows = mergeTourAvailabilitySlotsIntoWindows(
      ["2020-01-01:0", `!${FUTURE_DATE}:18`, `${FUTURE_DATE}:20`],
      afterFutureDate,
    );
    expect(windows).toHaveLength(0);
  });

  it("returns no windows for an empty slot list", () => {
    expect(mergeTourAvailabilitySlotsIntoWindows([], now)).toEqual([]);
  });
});

/**
 * `syncManagerAvailabilityToGoogleCalendar` (sync.server.ts) — WS3's "everything
 * the manager enters lands on Google; availability as free, tours as busy",
 * serialized per record through the `google_availability_push` state row.
 */
let CONNECTION: { connected: boolean; syncEnabled: boolean };
let CREATE_CALLS: Array<{ managerUserId: string; input: Record<string, unknown> }> = [];
let DELETE_CALLS: string[] = [];
let CREATE_RETURNS: (string | null)[] = [];
let DELETE_FAILS: Set<string> = new Set();
let ON_CREATE: (() => void) | null = null;

vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: vi.fn(async () => CONNECTION),
}));

vi.mock("@/lib/google-calendar/api.server", () => ({
  createGoogleCalendarEvent: vi.fn(async (_db: unknown, managerUserId: string, input: Record<string, unknown>) => {
    CREATE_CALLS.push({ managerUserId, input });
    ON_CREATE?.();
    return CREATE_RETURNS.shift() ?? `evt-${CREATE_CALLS.length}`;
  }),
  updateGoogleCalendarEvent: vi.fn(async () => null),
  deleteGoogleCalendarEvent: vi.fn(async (_db: unknown, _managerUserId: string, eventId: string) => {
    DELETE_CALLS.push(eventId);
    if (DELETE_FAILS.has(eventId)) throw new Error("rate limited");
  }),
}));

import {
  availabilityPushStateRecordId,
  syncManagerAvailabilityToGoogleCalendar,
} from "@/lib/google-calendar/sync.server";

type Row = { id: string; row_data: Record<string, unknown>; updated_at: string };

/** A `portal_schedule_records` table: the source record plus the server-owned push-state row. */
function fakeDb(rows: Row[]) {
  let clock = 0;
  const stamp = () => new Date(1_800_000_000_000 + ++clock).toISOString();
  const find = (id: string) => rows.find((row) => row.id === id) ?? null;
  const db = {
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => {
            const row = find(id);
            return { data: row ? { row_data: row.row_data, updated_at: row.updated_at } : null, error: null };
          },
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        if (find(String(row.id))) return { error: { message: "duplicate" } };
        rows.push({ id: String(row.id), row_data: row.row_data as Record<string, unknown>, updated_at: stamp() });
        return { error: null };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => ({
          eq: (_col2: string, expectedUpdatedAt: string) => ({
            select: () => ({
              maybeSingle: async () => {
                const row = find(id);
                if (!row || row.updated_at !== expectedUpdatedAt) return { data: null, error: null };
                row.row_data = patch.row_data as Record<string, unknown>;
                row.updated_at = stamp();
                return { data: { id }, error: null };
              },
            }),
          }),
        }),
      }),
    }),
    /** Simulates a manager saving the record again (a new slot set, fresh updated_at). */
    save: (id: string, rowData: Record<string, unknown>) => {
      const row = find(id);
      if (row) {
        row.row_data = rowData;
        row.updated_at = stamp();
      } else rows.push({ id, row_data: rowData, updated_at: stamp() });
    },
    state: () => find(availabilityPushStateRecordId("rec-1"))?.row_data ?? null,
  };
  return db;
}

const REC = "rec-1";

beforeEach(() => {
  CONNECTION = { connected: true, syncEnabled: true };
  CREATE_CALLS = [];
  DELETE_CALLS = [];
  CREATE_RETURNS = [];
  DELETE_FAILS = new Set();
  ON_CREATE = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("syncManagerAvailabilityToGoogleCalendar", () => {
  it("does nothing when Google Calendar is not connected", async () => {
    CONNECTION.connected = false;
    const db = fakeDb([{ id: REC, row_data: { payload: [`${FUTURE_DATE}:18`] }, updated_at: "t0" }]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });
    expect(CREATE_CALLS).toHaveLength(0);
  });

  it("pushes a merged window as a transparent 'Open for tours' event and records its id on the state row", async () => {
    const db = fakeDb([{ id: REC, row_data: { payload: [`${FUTURE_DATE}:18`, `${FUTURE_DATE}:19`] }, updated_at: "t0" }]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });

    expect(CREATE_CALLS).toHaveLength(1);
    expect(CREATE_CALLS[0]!.input.title).toBe("Open for tours");
    expect(CREATE_CALLS[0]!.input.transparency).toBe("transparent");
    expect(String(CREATE_CALLS[0]!.input.description)).toContain("Created from PropPlane");
    expect(db.state()).toMatchObject({ eventIds: ["evt-1"], lockedAt: null, dirty: false });
  });

  it("deletes every previously-pushed window before recreating", async () => {
    const db = fakeDb([
      { id: REC, row_data: { payload: [] }, updated_at: "t0" },
      { id: availabilityPushStateRecordId(REC), row_data: { eventIds: ["stale-1", "stale-2"], lockedAt: null }, updated_at: "s0" },
    ]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });
    expect(DELETE_CALLS.sort()).toEqual(["stale-1", "stale-2"]);
    expect(CREATE_CALLS).toHaveLength(0);
    expect(db.state()).toMatchObject({ eventIds: [] });
  });

  it("still cleans up ids a pre-state-row push left on the record itself", async () => {
    const db = fakeDb([{ id: REC, row_data: { payload: [] }, updated_at: "t0" }]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", {
      recordId: REC,
      previousRowData: { googleCalendarEventIds: ["legacy-1"] },
    });
    expect(DELETE_CALLS).toEqual(["legacy-1"]);
  });

  it("keeps an id whose Google delete failed so the next push retries it", async () => {
    DELETE_FAILS = new Set(["stale-1"]);
    const db = fakeDb([
      { id: REC, row_data: { payload: [`${FUTURE_DATE}:18`] }, updated_at: "t0" },
      { id: availabilityPushStateRecordId(REC), row_data: { eventIds: ["stale-1", "stale-2"], lockedAt: null }, updated_at: "s0" },
    ]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });
    expect((db.state() as { eventIds: string[] }).eventIds.sort()).toEqual(["evt-1", "stale-1"]);
  });

  it("a save landing mid-push is picked up by the same push, and nothing it created is orphaned", async () => {
    const db = fakeDb([{ id: REC, row_data: { payload: [`${FUTURE_DATE}:18`] }, updated_at: "t0" }]);
    ON_CREATE = () => {
      // The manager paints a second window while the first push is talking to Google.
      if (CREATE_CALLS.length === 1) db.save(REC, { payload: [`${FUTURE_DATE}:18`, `${FUTURE_DATE}:30`] });
    };
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });
    // Pass 1 created evt-1; pass 2 deleted it and created the two current windows.
    expect(DELETE_CALLS).toEqual(["evt-1"]);
    expect(CREATE_CALLS).toHaveLength(3);
    expect((db.state() as { eventIds: string[] }).eventIds.sort()).toEqual(["evt-2", "evt-3"]);
    expect(db.state()).toMatchObject({ lockedAt: null, dirty: false });
  });

  it("a push that finds the lock held marks the state dirty and leaves Google alone", async () => {
    const db = fakeDb([
      { id: REC, row_data: { payload: [`${FUTURE_DATE}:18`] }, updated_at: "t0" },
      {
        id: availabilityPushStateRecordId(REC),
        row_data: { eventIds: ["held-1"], lockedAt: new Date().toISOString(), dirty: false },
        updated_at: "s0",
      },
    ]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });
    expect(CREATE_CALLS).toHaveLength(0);
    expect(DELETE_CALLS).toHaveLength(0);
    expect(db.state()).toMatchObject({ eventIds: ["held-1"], dirty: true });
  });

  it("takes over a lock a crashed push left behind", async () => {
    const db = fakeDb([
      { id: REC, row_data: { payload: [`${FUTURE_DATE}:18`] }, updated_at: "t0" },
      {
        id: availabilityPushStateRecordId(REC),
        row_data: { eventIds: [], lockedAt: new Date(Date.now() - 10 * 60_000).toISOString(), dirty: false },
        updated_at: "s0",
      },
    ]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });
    expect(CREATE_CALLS).toHaveLength(1);
    expect(db.state()).toMatchObject({ eventIds: ["evt-1"], lockedAt: null });
  });

  it("never pushes tours or work orders as free — only this availability path sets transparency", async () => {
    const db = fakeDb([{ id: REC, row_data: { payload: [`${FUTURE_DATE}:18`] }, updated_at: "t0" }]);
    await syncManagerAvailabilityToGoogleCalendar(db as never, "mgr-1", { recordId: REC });
    expect(CREATE_CALLS[0]!.input.transparency).toBe("transparent");
  });
});
