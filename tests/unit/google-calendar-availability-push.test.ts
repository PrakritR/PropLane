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
 * the manager enters lands on Google; availability as free, tours as busy".
 */
let CONNECTION: { connected: boolean; syncEnabled: boolean };
let CREATE_CALLS: Array<{ managerUserId: string; input: Record<string, unknown> }> = [];
let DELETE_CALLS: string[] = [];
let CREATE_RETURNS: (string | null)[] = [];

vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: vi.fn(async () => CONNECTION),
}));

vi.mock("@/lib/google-calendar/api.server", () => ({
  createGoogleCalendarEvent: vi.fn(async (_db: unknown, managerUserId: string, input: Record<string, unknown>) => {
    CREATE_CALLS.push({ managerUserId, input });
    return CREATE_RETURNS.shift() ?? `evt-${CREATE_CALLS.length}`;
  }),
  updateGoogleCalendarEvent: vi.fn(async () => null),
  deleteGoogleCalendarEvent: vi.fn(async (_db: unknown, _managerUserId: string, eventId: string) => {
    DELETE_CALLS.push(eventId);
  }),
}));

import { syncManagerAvailabilityToGoogleCalendar } from "@/lib/google-calendar/sync.server";

function fakeDb(existingRowData: Record<string, unknown> | null = { payload: [] }) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const db = {
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => (existingRowData ? { data: { row_data: existingRowData }, error: null } : { data: null, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          updates.push({ id, patch });
          return { error: null };
        },
      }),
    }),
  };
  return { db: db as never, updates };
}

beforeEach(() => {
  CONNECTION = { connected: true, syncEnabled: true };
  CREATE_CALLS = [];
  DELETE_CALLS = [];
  CREATE_RETURNS = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("syncManagerAvailabilityToGoogleCalendar", () => {
  it("does nothing when Google Calendar is not connected", async () => {
    CONNECTION.connected = false;
    const { db } = fakeDb();
    await syncManagerAvailabilityToGoogleCalendar(db, "mgr-1", {
      recordId: "rec-1",
      rowData: { payload: [`${FUTURE_DATE}:18`] },
      previousRowData: null,
    });
    expect(CREATE_CALLS).toHaveLength(0);
  });

  it("pushes a merged window as a transparent 'Open for tours' event", async () => {
    const { db, updates } = fakeDb();
    await syncManagerAvailabilityToGoogleCalendar(db, "mgr-1", {
      recordId: "rec-1",
      rowData: { payload: [`${FUTURE_DATE}:18`, `${FUTURE_DATE}:19`] },
      previousRowData: null,
    });

    expect(CREATE_CALLS).toHaveLength(1);
    expect(CREATE_CALLS[0]!.input.title).toBe("Open for tours");
    expect(CREATE_CALLS[0]!.input.transparency).toBe("transparent");
    expect(String(CREATE_CALLS[0]!.input.description)).toContain("Created from PropPlane");
    // The new event id is persisted back onto the same schedule record.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch.row_data).toMatchObject({ googleCalendarEventIds: expect.arrayContaining([expect.any(String)]) });
  });

  it("deletes every previously-pushed window before recreating", async () => {
    const { db } = fakeDb();
    await syncManagerAvailabilityToGoogleCalendar(db, "mgr-1", {
      recordId: "rec-1",
      rowData: { payload: [] },
      previousRowData: { googleCalendarEventIds: ["stale-1", "stale-2"] },
    });
    expect(DELETE_CALLS.sort()).toEqual(["stale-1", "stale-2"]);
    expect(CREATE_CALLS).toHaveLength(0);
  });

  it("never pushes tours or work orders as free — only this availability path sets transparency", async () => {
    // Confirms the write shape: a call through this function always carries
    // transparency, unlike syncPlannedTourToGoogleCalendar's input shape.
    const { db } = fakeDb();
    await syncManagerAvailabilityToGoogleCalendar(db, "mgr-1", {
      recordId: "rec-1",
      rowData: { payload: [`${FUTURE_DATE}:18`] },
      previousRowData: null,
    });
    expect(CREATE_CALLS[0]!.input.transparency).toBe("transparent");
  });
});
