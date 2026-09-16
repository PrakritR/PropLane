/**
 * WS3 review findings on `GET /api/portal/google-calendar/events`:
 *
 * - the persisted `google_meeting` mirror is loaded INDEPENDENTLY of the live
 *   Google call, so a classified live failure (expired token, API disabled)
 *   still answers with the mirrored meetings instead of an empty calendar;
 * - live and persisted rows are merged deduped by Google event id, live wins;
 * - the manager's own painted-availability echo ("Open for tours", carrying the
 *   `Type: availability` marker) never renders as a second block on the grid;
 * - the poll-on-read incremental pull is scheduled after the response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPLANE_AVAILABILITY_TYPE_MARKER, PROPLANE_GOOGLE_CALENDAR_MARKER } from "@/lib/google-calendar/markers";

const listLive = vi.fn();
const loadPersisted = vi.fn();
const pull = vi.fn(async () => undefined);
const afterMock = vi.fn((task: () => unknown) => void task());

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => afterMock(task) };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "mgr-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: table === "profiles" ? { role: "manager" } : null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: table === "profile_roles" ? [{ role: "manager" }] : [] }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: async () => ({ connected: true, syncEnabled: true, calendarId: "primary" }),
}));
vi.mock("@/lib/google-calendar/debug-log.server", () => ({ debugGoogleCalendarLog: () => {} }));
vi.mock("@/lib/google-calendar/api.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google-calendar/api.server")>();
  return { ...actual, listGoogleCalendarEventsPaged: (...args: unknown[]) => listLive(...args) };
});
vi.mock("@/lib/google-calendar/persisted-meetings.server", () => ({
  loadPersistedGoogleMeetings: (...args: unknown[]) => loadPersisted(...args),
}));
vi.mock("@/lib/google-calendar/pull.server", () => ({
  pullGoogleCalendarMeetings: (...args: unknown[]) => pull(...args),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({ deleteProplaneGoogleCalendarEvent: vi.fn() }));

function apiEvent(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary,
    start: "2026-09-21T17:00:00.000Z",
    end: "2026-09-21T18:00:00.000Z",
    ...extra,
  };
}

const request = () =>
  new Request("http://localhost/api/portal/google-calendar/events?timeMin=2026-09-20T00:00:00Z&timeMax=2026-09-28T00:00:00Z");

beforeEach(() => {
  listLive.mockReset();
  loadPersisted.mockReset();
  pull.mockClear();
  afterMock.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/portal/google-calendar/events — persisted mirror + echo filter", () => {
  it("answers with the persisted mirror when the live Google call fails with a classified error", async () => {
    loadPersisted.mockResolvedValue([apiEvent("g-persisted", "Dentist (mirrored)")]);
    listLive.mockRejectedValue(new Error("Google Calendar token expired; reconnect"));
    const { GET } = await import("@/app/api/portal/google-calendar/events/route");

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.warning).toBe("calendar_not_connected");
    expect(body.meetings.map((m: { sourceId: string; title: string }) => [m.sourceId, m.title])).toEqual([
      ["g-persisted", "Dentist (mirrored)"],
    ]);
    // The mirror was read before the live call, not as a fallback inside its catch.
    expect(loadPersisted).toHaveBeenCalledTimes(1);
  });

  it("merges live + persisted deduped by Google event id (live wins) and drops the availability echo", async () => {
    loadPersisted.mockResolvedValue([
      apiEvent("g-shared", "Stale mirrored title"),
      apiEvent("g-only-persisted", "Only in the mirror"),
    ]);
    listLive.mockResolvedValue({
      events: [
        apiEvent("g-shared", "Live title"),
        apiEvent("g-echo", "Open for tours", {
          transparency: "transparent",
          description: `${PROPLANE_GOOGLE_CALENDAR_MARKER}\n${PROPLANE_AVAILABILITY_TYPE_MARKER}`,
        }),
      ],
      truncated: false,
    });
    const { GET } = await import("@/app/api/portal/google-calendar/events/route");

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.truncated).toBe(false);
    const byId = Object.fromEntries(body.meetings.map((m: { sourceId: string; title: string }) => [m.sourceId, m.title]));
    expect(byId).toEqual({ "g-shared": "Live title", "g-only-persisted": "Only in the mirror" });
    expect(byId["g-echo"]).toBeUndefined();
  });

  it("schedules the poll-on-read incremental pull after the response", async () => {
    loadPersisted.mockResolvedValue([]);
    listLive.mockResolvedValue({ events: [], truncated: false });
    const { GET } = await import("@/app/api/portal/google-calendar/events/route");

    await GET(request());

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith(expect.anything(), "mgr-1");
  });
});
