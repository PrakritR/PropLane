import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The busy window a manager calendar reads is wide (nine weeks) on purpose — a
 * slot outside it is a conflict nobody can see, which is the double-booking
 * failure F-CAL-6 is about. Google returns events in START-TIME order and caps a
 * page, so an unpaginated read drops the FAR end of the range: exactly the weeks
 * the wide window was chosen to cover, and silently.
 */

const connection = {
  connected: true,
  syncEnabled: true,
  calendarId: "primary",
  refreshToken: "refresh-token",
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};

vi.mock("@/lib/google-calendar/settings", () => ({
  isGoogleCalendarOAuthConfigured: () => true,
  loadGoogleCalendarConnection: async () => connection,
  saveGoogleCalendarConnection: async () => connection,
  resolveGoogleCalendarOAuthConfig: () => ({ clientId: "id", clientSecret: "secret" }),
}));
vi.mock("@/lib/google-calendar/debug-log.server", () => ({ debugGoogleCalendarLog: () => {} }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: vi.fn().mockResolvedValue(undefined),
  TestWorkspaceProviderDisabledError: class TestWorkspaceProviderDisabledError extends Error {},
}));

import {
  GOOGLE_CALENDAR_EVENT_PAGE_LIMIT,
  listGoogleCalendarEventsPaged,
} from "@/lib/google-calendar/api.server";

const db = {} as never;

function event(id: string) {
  return {
    id,
    summary: `Busy ${id}`,
    start: { dateTime: "2026-08-03T10:00:00Z" },
    end: { dateTime: "2026-08-03T11:00:00Z" },
  };
}

/** Serves `pages` pages, each linking to the next. */
function pagedFetch(pages: Array<{ items: unknown[]; nextPageToken?: string }>) {
  let call = 0;
  return vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)]!;
    call += 1;
    return { ok: true, json: async () => page } as unknown as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listGoogleCalendarEventsPaged pagination", () => {
  it("follows nextPageToken so the far end of the window is not dropped", async () => {
    const fetchMock = pagedFetch([
      { items: [event("a")], nextPageToken: "p2" },
      { items: [event("b")], nextPageToken: "p3" },
      { items: [event("c")] },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const { events, truncated } = await listGoogleCalendarEventsPaged(db, "mgr-1", "min", "max");

    expect(events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Page 2 onwards carries the token; every page keeps the same window.
    const second = String(fetchMock.mock.calls[1]![0]);
    expect(second).toContain("pageToken=p2");
    expect(second).toContain("timeMin=min");
  });

  it("stops at one page when the calendar has no more", async () => {
    const fetchMock = pagedFetch([{ items: [event("a")] }]);
    vi.stubGlobal("fetch", fetchMock);

    const { events, truncated } = await listGoogleCalendarEventsPaged(db, "mgr-1", "min", "max");

    expect(events).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("pageToken");
  });

  it("reports truncation rather than returning a short list that reads as complete", async () => {
    // Every page offers another one, so the bound is what stops it.
    const fetchMock = pagedFetch([{ items: [event("a")], nextPageToken: "more" }]);
    vi.stubGlobal("fetch", fetchMock);

    const { events, truncated } = await listGoogleCalendarEventsPaged(db, "mgr-1", "min", "max");

    expect(fetchMock).toHaveBeenCalledTimes(GOOGLE_CALENDAR_EVENT_PAGE_LIMIT);
    expect(events).toHaveLength(GOOGLE_CALENDAR_EVENT_PAGE_LIMIT);
    expect(truncated).toBe(true);
  });

  it("surfaces an API error instead of a partial page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: { message: "Calendar API has not been used" } }),
      }) as unknown as Response),
    );

    await expect(listGoogleCalendarEventsPaged(db, "mgr-1", "min", "max")).rejects.toThrow(
      /Calendar API has not been used/,
    );
  });
});
