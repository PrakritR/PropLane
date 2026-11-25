/**
 * The no-op-write guard on a channel connection has to actually skip a write. The cron pulls every feed on a fixed
 * cadence (`vercel.json`), so a restamp window at or under that cadence never skips anything: every run arrives
 * already older than the window and rewrites the row with the values it already held.
 *
 * Oracle: the cron schedule in `vercel.json` for `/api/cron/sync-channel-calendars`, which is what decides how far
 * apart two consecutive runs are. Plausible wrong behaviour this rejects: a window of one cadence or less (the
 * 10-minute one this replaces), where the second unchanged run moves `last_synced_at` and `updated_at` again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

const mocks = vi.hoisted(() => ({
  managerCanWriteCalendarForProperty: vi.fn(async () => true),
  managerCanWriteCalendarForProperties: vi.fn(async (_db: unknown, _user: string, ids: readonly string[]) => new Set(ids)),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanWriteCalendarForProperty: mocks.managerCanWriteCalendarForProperty,
  managerCanWriteCalendarForProperties: mocks.managerCanWriteCalendarForProperties,
}));
vi.mock("@/lib/channel-calendar/airbnb-residents.server", () => ({
  upsertAirbnbResidentsFromImportedRanges: vi.fn(async () => ({ created: 0, updated: 0, skipped: 0 })),
  releaseAirbnbResidentsAbsentFromFeed: async () => undefined,
}));

import { syncChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";

const MANAGER = "mgr-1";
const IMPORT_URL = "https://www.airbnb.com/calendar/ical/123.ics?s=abc";
const T0 = Date.parse("2026-11-20T18:00:00.000Z");

/** How far apart two cron runs are, from the schedule the platform runs it on. */
function cronCadenceMs(path: string): number {
  const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  const entry = config.crons.find((cron) => cron.path === path);
  if (!entry) throw new Error(`no cron for ${path}`);
  const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(entry.schedule);
  if (!minutes) throw new Error(`cadence of ${entry.schedule} is not a minute step`);
  return Number(minutes[1]) * 60_000;
}

type Ev = { uid: string; summary: string; start: string; end: string };
const MARCUS: Ev = { uid: "uid-marcus", summary: "Marcus", start: "20261210", end: "20261215" };
const PRIYA: Ev = { uid: "uid-priya", summary: "Priya", start: "20261220", end: "20261223" };

function feedIs(...events: Ev[]) {
  const body = events
    .map((e) => `BEGIN:VEVENT\nUID:${e.uid}\nSUMMARY:${e.summary}\nDTSTART;VALUE=DATE:${e.start}\nDTEND;VALUE=DATE:${e.end}\nEND:VEVENT`)
    .join("\n");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`)));
}

function setup() {
  const tables: Record<string, Row[]> = {
    external_calendar_connections: [
      {
        id: "conn-1",
        manager_user_id: MANAGER,
        property_id: "prop-1",
        room_id: "room-1",
        provider: "airbnb",
        label: "Room 1",
        import_url: IMPORT_URL,
        export_token: "tok",
        imported_ranges: [],
        last_synced_at: null,
        last_error: null,
      },
    ],
    manager_property_records: [
      {
        id: "prop-1",
        manager_user_id: MANAGER,
        property_data: {
          id: "prop-1",
          title: "House",
          listingSubmission: { v: 1, rooms: [{ id: "room-1", name: "Room 1", manualUnavailableRanges: [] }] },
        },
        row_data: {},
      },
    ],
    portal_schedule_records: [],
  };
  const db = fakeSupabaseClient(tables) as never;
  const stamp = () => String(tables.external_calendar_connections[0]!.last_synced_at ?? "");
  const touched = () => String(tables.external_calendar_connections[0]!.updated_at ?? "");
  return { tables, db, stamp, touched };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mocks.managerCanWriteCalendarForProperty.mockReset().mockResolvedValue(true);
  feedIs(MARCUS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an unchanged channel feed on the cron's own cadence", () => {
  it("does not rewrite the connection row every run", async () => {
    const { db, stamp, touched } = setup();
    const cadence = cronCadenceMs("/api/cron/sync-channel-calendars");

    await syncChannelCalendarConnection(db, "conn-1");
    const first = stamp();
    expect(first).toBe(new Date(T0).toISOString());

    vi.setSystemTime(T0 + cadence);
    await syncChannelCalendarConnection(db, "conn-1");
    expect(stamp()).toBe(first);
    expect(touched()).toBe(new Date(T0).toISOString());

    // Every further run inside the hour is left alone too.
    for (const run of [2, 3]) {
      vi.setSystemTime(T0 + cadence * run);
      await syncChannelCalendarConnection(db, "conn-1");
      expect(stamp(), `run ${run}`).toBe(first);
    }
  });

  it("restamps once the stamp is genuinely old, so Last synced never reads stale", async () => {
    const { db, stamp } = setup();
    await syncChannelCalendarConnection(db, "conn-1");
    const first = stamp();

    const later = T0 + 61 * 60_000;
    vi.setSystemTime(later);
    await syncChannelCalendarConnection(db, "conn-1");
    expect(stamp()).not.toBe(first);
    expect(stamp()).toBe(new Date(later).toISOString());
    // Under the two hours `channel-health.ts` calls a stale sync, every run through.
    expect(later - Date.parse(first)).toBeLessThan(2 * 60 * 60_000);
  });

  it("writes at once when the feed actually changed, window or no window", async () => {
    const { db, tables, stamp } = setup();
    await syncChannelCalendarConnection(db, "conn-1");
    const first = stamp();

    const soon = T0 + 60_000;
    vi.setSystemTime(soon);
    feedIs(MARCUS, PRIYA);
    await syncChannelCalendarConnection(db, "conn-1");
    expect(stamp()).toBe(new Date(soon).toISOString());
    expect((tables.external_calendar_connections[0]!.imported_ranges as Array<{ sourceUid: string }>).map((r) => r.sourceUid).sort()).toEqual([
      "uid-marcus",
      "uid-priya",
    ]);
    expect(first).not.toBe(stamp());
  });
});
