import { afterEach, describe, expect, it, vi } from "vitest";

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

import { createGoogleCalendarEvent, updateGoogleCalendarEvent } from "@/lib/google-calendar/api.server";

afterEach(() => vi.unstubAllGlobals());

describe("deterministic Google Calendar create conflict reconciliation", () => {
  it("patches the current tour window after a 409 instead of preserving stale content", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Already exists" } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deterministic-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGoogleCalendarEvent({} as never, "manager-1", {
      id: "deterministic-id",
      title: "Rescheduled tour",
      start: "2099-11-09T18:00:00.000Z",
      end: "2099-11-09T18:30:00.000Z",
    })).resolves.toBe("deterministic-id");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/events/deterministic-id");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: expect.stringContaining('"start":{"dateTime":"2099-11-09T18:00:00.000Z"}'),
    });
  });

  // A tour handed to a teammate and back: the first reassign DELETED this id from the owner's calendar, and Google keeps
  // a deleted event as `status: "cancelled"` under the same id (Events: insert / get, "Cancelled events ... are still
  // returned"). So the create comes back 409 and the reconciling PATCH has to say `confirmed`, or the id resolves while
  // the event stays invisible on every calendar.
  it("revives a cancelled event of ours on the 409 reconcile", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "The requested identifier already exists." } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deterministic-id", status: "confirmed" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGoogleCalendarEvent({} as never, "manager-1", {
      id: "deterministic-id",
      title: "Tour",
      start: "2099-11-09T18:00:00.000Z",
      end: "2099-11-09T18:30:00.000Z",
    })).resolves.toBe("deterministic-id");

    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as { body?: string } | undefined)?.body ?? "{}"))).toMatchObject({ status: "confirmed" });
  });

  it("an ordinary update never revives: a person's own deletion in Google stays deleted", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "deterministic-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateGoogleCalendarEvent({} as never, "manager-1", "deterministic-id", {
      title: "Tour",
      start: "2099-11-09T18:00:00.000Z",
      end: "2099-11-09T18:30:00.000Z",
    })).resolves.toBe("deterministic-id");

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined)?.body ?? "{}"))).not.toHaveProperty("status");
  });
});
