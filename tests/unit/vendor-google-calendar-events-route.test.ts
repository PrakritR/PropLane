import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

/**
 * Vendor clone of `/api/portal/google-calendar/events` — read-only busy time
 * for the vendor's OWN connected calendar, gated on the vendor role instead
 * of manager. Unlike the manager route (see
 * google-calendar-events-route-mirror.test.ts), nothing is ever pushed onto a
 * vendor's calendar, so this skips the persisted-meeting mirror + poll-on-read
 * pull entirely — these tests pin that it is a plain live read keyed by the
 * vendor's OWN userId, never a manager's.
 */

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  assertGoogleCalendarProviderAllowed: vi.fn(async () => undefined),
  classifyGoogleCalendarEventsFetchError: vi.fn(),
  listGoogleCalendarEventsPaged: vi.fn(),
  loadGoogleCalendarConnection: vi.fn(),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: mocks.resolveVendorPortalUserId,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));
vi.mock("@/lib/google-calendar/debug-log.server", () => ({ debugGoogleCalendarLog: () => {} }));
vi.mock("@/lib/google-calendar/api.server", () => ({
  assertGoogleCalendarProviderAllowed: mocks.assertGoogleCalendarProviderAllowed,
  classifyGoogleCalendarEventsFetchError: mocks.classifyGoogleCalendarEventsFetchError,
  listGoogleCalendarEventsPaged: mocks.listGoogleCalendarEventsPaged,
}));
vi.mock("@/lib/google-calendar/settings", () => ({
  loadGoogleCalendarConnection: mocks.loadGoogleCalendarConnection,
}));

function apiEvent(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary,
    description: "",
    start: "2026-09-21T17:00:00.000Z",
    end: "2026-09-21T18:00:00.000Z",
    ...extra,
  };
}

const url = "http://t/api/vendor/google-calendar/events?timeMin=2026-09-20T00:00:00Z&timeMax=2026-09-28T00:00:00Z";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
});

describe("GET /api/vendor/google-calendar/events", () => {
  it("401s an unauthenticated caller without ever reading the connection", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 401 });
    const { GET } = await import("@/app/api/vendor/google-calendar/events/route");
    const res = await GET(jsonRequest(url));
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);

    expect(status).toBe(401);
    expect(data.error).toMatch(/unauthorized/i);
    expect(mocks.loadGoogleCalendarConnection).not.toHaveBeenCalled();
  });

  it("400s a request missing timeMin/timeMax", async () => {
    const { GET } = await import("@/app/api/vendor/google-calendar/events/route");
    const res = await GET(jsonRequest("http://t/api/vendor/google-calendar/events"));
    expect(res.status).toBe(400);
  });

  it("answers an empty list without a live call when the vendor has not connected", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: false });
    const { GET } = await import("@/app/api/vendor/google-calendar/events/route");

    const res = await GET(jsonRequest(url));
    const { status, data } = await parseJsonResponse<{ meetings?: unknown[] }>(res);

    expect(status).toBe(200);
    expect(data.meetings).toEqual([]);
    expect(mocks.listGoogleCalendarEventsPaged).not.toHaveBeenCalled();
  });

  it("reads the vendor's OWN connected calendar, keyed by the vendor's userId, and maps every event to a busy/free private block", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true, calendarId: "primary" });
    mocks.listGoogleCalendarEventsPaged.mockResolvedValue({
      events: [apiEvent("g-1", "Dentist"), apiEvent("g-2", "Coffee with a friend", { transparency: "transparent" })],
      truncated: false,
    });
    const { GET } = await import("@/app/api/vendor/google-calendar/events/route");

    const res = await GET(jsonRequest(url));
    const { status, data } = await parseJsonResponse<{
      meetings?: {
        sourceId: string;
        googleCalendarPrivate?: boolean;
        statusLabel?: string;
        blocksTourAvailability?: boolean;
      }[];
      truncated?: boolean;
    }>(res);

    expect(status).toBe(200);
    expect(data.truncated).toBe(false);
    expect(mocks.listGoogleCalendarEventsPaged).toHaveBeenCalledWith(
      expect.anything(),
      "vendor-1",
      "2026-09-20T00:00:00Z",
      "2026-09-28T00:00:00Z",
    );
    // Neither event carries a PropLane marker (nothing is ever pushed onto a
    // vendor's calendar), so both land on the generic private/busy branch —
    // a personal busy/free block, never a tour or service-visit shape.
    expect(data.meetings).toHaveLength(2);
    for (const meeting of data.meetings ?? []) {
      expect(meeting.googleCalendarPrivate).toBe(true);
    }
    const byId = Object.fromEntries((data.meetings ?? []).map((m) => [m.sourceId, m]));
    expect(byId["g-1"]?.statusLabel).toBe("Blocked");
    expect(byId["g-1"]?.blocksTourAvailability).not.toBe(false);
    expect(byId["g-2"]?.statusLabel).toBe("Free");
    expect(byId["g-2"]?.blocksTourAvailability).toBe(false);
  });

  it("flags truncation so a caller never treats a partial read as the whole busy window", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true });
    mocks.listGoogleCalendarEventsPaged.mockResolvedValue({ events: [], truncated: true });
    const { GET } = await import("@/app/api/vendor/google-calendar/events/route");

    const res = await GET(jsonRequest(url));
    const { data } = await parseJsonResponse<{ truncated?: boolean; warning?: string }>(res);
    expect(data.truncated).toBe(true);
    expect(data.warning).toBe("calendar_events_truncated");
  });

  it("classifies a live failure into a warning instead of a 500 — the read never lies about a full calendar", async () => {
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true });
    mocks.listGoogleCalendarEventsPaged.mockRejectedValue(new Error("Google Calendar token expired; reconnect"));
    mocks.classifyGoogleCalendarEventsFetchError.mockReturnValue({
      warning: "calendar_not_connected",
      hint: "reconnect",
    });
    const { GET } = await import("@/app/api/vendor/google-calendar/events/route");

    const res = await GET(jsonRequest(url));
    const { status, data } = await parseJsonResponse<{ meetings?: unknown[]; warning?: string }>(res);
    expect(status).toBe(200);
    expect(data.meetings).toEqual([]);
    expect(data.warning).toBe("calendar_not_connected");
  });
});
