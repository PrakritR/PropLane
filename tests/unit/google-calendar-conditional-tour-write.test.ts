import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/google-calendar/settings", () => ({
  isGoogleCalendarOAuthConfigured: () => true,
  loadGoogleCalendarConnection: settings.load,
  resolveGoogleCalendarOAuthConfig: () => ({ clientId: "client", clientSecret: "secret" }),
  saveGoogleCalendarConnection: settings.save,
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: vi.fn().mockResolvedValue(undefined),
  TestWorkspaceProviderDisabledError: class TestWorkspaceProviderDisabledError extends Error {},
}));

import {
  GoogleCalendarWriteSupersededError,
  updateGoogleCalendarEvent,
} from "@/lib/google-calendar/api.server";

const connection = {
  connected: true,
  email: "manager@example.test",
  syncEnabled: true,
  refreshToken: "refresh-token",
  accessToken: "access-token",
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  calendarId: "primary",
};

const input = {
  title: "Prospect tour",
  start: "2098-01-01T17:00:00.000Z",
  end: "2098-01-01T17:30:00.000Z",
};

describe("Google Calendar conditional tour writes", () => {
  beforeEach(() => {
    settings.load.mockReset().mockResolvedValue(connection);
    settings.save.mockReset();
    vi.unstubAllGlobals();
  });

  it("reads an ETag, revalidates durable state, and PATCHes with If-Match", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method) {
        order.push("get");
        return new Response(JSON.stringify({ id: "google-event", etag: '"v1"' }), {
          status: 200,
          headers: { ETag: '"v1"', "Content-Type": "application/json" },
        });
      }
      order.push("patch");
      expect(new Headers(init.headers).get("If-Match")).toBe('"v1"');
      return new Response(JSON.stringify({ id: "google-event" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateGoogleCalendarEvent({} as never, "manager", "google-event", input, {
      validateCurrent: async () => {
        order.push("validate");
        return true;
      },
    })).resolves.toBe("google-event");
    expect(order).toEqual(["get", "validate", "patch"]);
  });

  it("does not PATCH when durable state changed after the ETag read", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ etag: '"v1"' }), {
      status: 200,
      headers: { ETag: '"v1"', "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateGoogleCalendarEvent({} as never, "manager", "google-event", input, {
      validateCurrent: async () => false,
    })).rejects.toBeInstanceOf(GoogleCalendarWriteSupersededError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces 412 as superseded without retrying the stale payload", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ etag: '"v1"' }), {
        status: 200,
        headers: { ETag: '"v1"', "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Precondition Failed" } }), {
        status: 412,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateGoogleCalendarEvent({} as never, "manager", "google-event", input, {
      validateCurrent: async () => true,
    })).rejects.toBeInstanceOf(GoogleCalendarWriteSupersededError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
