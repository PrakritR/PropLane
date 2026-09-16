import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `pullGoogleCalendarMeetings` (pull.server.ts) — the WS3 incremental-sync
 * writer. Covers the three-way contract it owns: a confirmed non-PropLane
 * event is mirrored as a `google_meeting` row, a cancelled one deletes its
 * row, and a PropLane-originated event (carries the marker) is skipped so
 * PropLane's own pushed tours/work-orders/availability never double up with
 * a persisted copy of themselves.
 */

type SyncEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string;
  description?: string;
  start?: string;
  end?: string;
  transparency?: "opaque" | "transparent";
};

let CONNECTION: {
  connected: boolean;
  syncEnabled: boolean;
  syncToken: string | null;
  channelId: string | null;
  channelResourceId: string | null;
  channelExpiryMs: number | null;
};
type SyncPage = { events: SyncEvent[]; nextSyncToken?: string; syncTokenInvalid: boolean };
let SYNC_PAGE: SyncPage;
/** When set, consumed one page per call (in order) instead of `SYNC_PAGE` — for tests with more than one call. */
let SYNC_SEQUENCE: SyncPage[] = [];
let SYNC_CALLS: Array<string | null> = [];
let WATCH_CALLS = 0;
let SAVE_PATCHES: Array<Record<string, unknown>> = [];

class FakeNotLinkedError extends Error {}

vi.mock("@/lib/google-calendar/api.server", () => ({
  isGoogleCalendarNotLinkedError: (e: unknown) => e instanceof FakeNotLinkedError,
  listGoogleCalendarEventsForSync: vi.fn(async (_db: unknown, _uid: string, syncToken: string | null) => {
    SYNC_CALLS.push(syncToken);
    if (SYNC_SEQUENCE.length > 0) return SYNC_SEQUENCE.shift()!;
    return SYNC_PAGE;
  }),
  watchGoogleCalendar: vi.fn(async () => {
    WATCH_CALLS += 1;
    return { channelId: "chan-1", resourceId: "res-1", expiration: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  }),
}));

vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: vi.fn(async () => CONNECTION),
  saveGoogleCalendarConnection: vi.fn(async (_db: unknown, _uid: string, patch: Record<string, unknown>) => {
    SAVE_PATCHES.push(patch);
    Object.assign(CONNECTION, patch);
    return CONNECTION;
  }),
}));

vi.mock("@/lib/app-url", () => ({
  resolveEmailLinkBaseUrl: () => "https://prop-lane.space",
}));

import { pullGoogleCalendarMeetings } from "@/lib/google-calendar/pull.server";

function fakeDb() {
  const deletedIds: string[] = [];
  const upserted: Array<Record<string, unknown>> = [];
  const db = {
    from: (_table: string) => ({
      delete: () => ({
        eq: async (_col: string, id: string) => {
          deletedIds.push(id);
          return { error: null };
        },
      }),
      upsert: async (row: Record<string, unknown>) => {
        upserted.push(row);
        return { error: null };
      },
    }),
  };
  return { db: db as never, deletedIds, upserted };
}

beforeEach(() => {
  CONNECTION = {
    connected: true,
    syncEnabled: true,
    syncToken: "token-1",
    channelId: "chan-existing",
    channelResourceId: "res-existing",
    channelExpiryMs: Date.now() + 6 * 24 * 60 * 60 * 1000, // outside the 24h renewal window
  };
  SYNC_PAGE = { events: [], syncTokenInvalid: false };
  SYNC_SEQUENCE = [];
  SYNC_CALLS = [];
  WATCH_CALLS = 0;
  SAVE_PATCHES = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("pullGoogleCalendarMeetings", () => {
  it("skips managers with no working Google link", async () => {
    CONNECTION.connected = false;
    const { db } = fakeDb();
    const result = await pullGoogleCalendarMeetings(db, "mgr-1");
    expect(result).toEqual({ ok: false, upserted: 0, deleted: 0, skippedProplaneOriginated: 0, reason: "not_connected" });
  });

  it("upserts a confirmed non-PropLane meeting as a google_meeting row", async () => {
    SYNC_PAGE = {
      events: [
        {
          id: "g-1",
          status: "confirmed",
          summary: "Dentist",
          start: "2030-01-07T17:00:00.000Z",
          end: "2030-01-07T18:00:00.000Z",
          transparency: "opaque",
        },
      ],
      syncTokenInvalid: false,
    };
    const { db, upserted } = fakeDb();
    const result = await pullGoogleCalendarMeetings(db, "mgr-1");

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(1);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.id).toBe("axis_google_meeting_mgr-1_g-1");
    expect(upserted[0]!.record_type).toBe("google_meeting");
    expect(upserted[0]!.manager_user_id).toBe("mgr-1");
    expect((upserted[0]!.row_data as Record<string, unknown>).googleEventId).toBe("g-1");
  });

  it("deletes the mirrored row for a cancelled Google event", async () => {
    SYNC_PAGE = { events: [{ id: "g-2", status: "cancelled", summary: "" }], syncTokenInvalid: false };
    const { db, deletedIds } = fakeDb();
    const result = await pullGoogleCalendarMeetings(db, "mgr-1");

    expect(result.deleted).toBe(1);
    expect(deletedIds).toEqual(["axis_google_meeting_mgr-1_g-2"]);
  });

  it("skips a PropLane-originated event (carries the marker) rather than mirroring it", async () => {
    SYNC_PAGE = {
      events: [
        {
          id: "g-3",
          status: "confirmed",
          summary: "Tour · Jane Doe",
          description: "Type: tour\nGuest: Jane Doe\nCreated from PropPlane",
          start: "2030-01-07T17:00:00.000Z",
          end: "2030-01-07T17:30:00.000Z",
        },
      ],
      syncTokenInvalid: false,
    };
    const { db, upserted } = fakeDb();
    const result = await pullGoogleCalendarMeetings(db, "mgr-1");

    expect(result.skippedProplaneOriginated).toBe(1);
    expect(upserted).toHaveLength(0);
  });

  it("persists the new syncToken for the next incremental pull", async () => {
    SYNC_PAGE = { events: [], nextSyncToken: "token-2", syncTokenInvalid: false };
    const { db } = fakeDb();
    await pullGoogleCalendarMeetings(db, "mgr-1");
    expect(SAVE_PATCHES.some((p) => p.syncToken === "token-2")).toBe(true);
  });

  it("on a 410 syncTokenInvalid, drops the token and retries once with a full sync", async () => {
    SYNC_SEQUENCE = [
      { events: [], syncTokenInvalid: true },
      { events: [], nextSyncToken: "fresh-token", syncTokenInvalid: false },
    ];
    const { db } = fakeDb();
    const result = await pullGoogleCalendarMeetings(db, "mgr-1");

    expect(result.ok).toBe(true);
    // First call carried the stale token, the retry carried none (full sync).
    expect(SYNC_CALLS).toEqual(["token-1", null]);
    expect(SAVE_PATCHES.some((p) => p.syncToken === null)).toBe(true);
    expect(SAVE_PATCHES.some((p) => p.syncToken === "fresh-token")).toBe(true);
  });

  it("renews the watch channel when none is on file", async () => {
    CONNECTION.channelId = null;
    CONNECTION.channelExpiryMs = null;
    const { db } = fakeDb();
    await pullGoogleCalendarMeetings(db, "mgr-1");
    expect(WATCH_CALLS).toBe(1);
    expect(SAVE_PATCHES.some((p) => p.channelId === "chan-1")).toBe(true);
  });

  it("does not renew a channel that is not close to expiring", async () => {
    const { db } = fakeDb();
    await pullGoogleCalendarMeetings(db, "mgr-1");
    expect(WATCH_CALLS).toBe(0);
  });
});
