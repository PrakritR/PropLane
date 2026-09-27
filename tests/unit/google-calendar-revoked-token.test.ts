import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connect-reliability: a revoked/expired Google refresh token
 * (`invalid_grant`/`invalid_token`) must proactively disconnect the
 * connection (so the UI can offer "Reconnect" instead of failing forever on
 * an opaque error), and a granular-consent grant missing `calendar.events`
 * must never be saved as `connected: true`.
 */

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
  exchangeGoogleCalendarCode,
  getGoogleCalendarAccessToken,
  isGoogleCalendarNotLinkedError,
} from "@/lib/google-calendar/api.server";

const connection = {
  connected: true,
  email: "manager@example.test",
  syncEnabled: true,
  refreshToken: "refresh-token",
  accessToken: null,
  accessTokenExpiresAt: null,
  calendarId: "primary",
};

describe("Google Calendar refresh-token revocation", () => {
  beforeEach(() => {
    settings.load.mockReset().mockResolvedValue(connection);
    settings.save.mockReset().mockResolvedValue(connection);
    vi.unstubAllGlobals();
  });

  it("proactively disconnects and clears tokens on invalid_grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );

    await expect(getGoogleCalendarAccessToken({} as never, "manager-1")).rejects.toThrow(/revoked/i);
    expect(settings.save).toHaveBeenCalledWith(
      {},
      "manager-1",
      expect.objectContaining({ connected: false, refreshToken: null, accessToken: null, revoked: true }),
    );
  });

  it("classifies the resulting error as a not-linked (skippable) failure, not a hard error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    try {
      await getGoogleCalendarAccessToken({} as never, "manager-1");
      throw new Error("expected to throw");
    } catch (e) {
      expect(isGoogleCalendarNotLinkedError(e)).toBe(true);
    }
  });

  it("does not mark the connection disconnected for an ordinary transient refresh failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 })),
    );

    await expect(getGoogleCalendarAccessToken({} as never, "manager-1")).rejects.toThrow("server_error");
    expect(settings.save).not.toHaveBeenCalled();
  });
});

describe("Google Calendar granular consent on connect", () => {
  beforeEach(() => {
    settings.load.mockReset().mockResolvedValue({ ...connection, refreshToken: null });
    settings.save.mockReset().mockResolvedValue(connection);
    vi.unstubAllGlobals();
  });

  it("rejects a token response that granted scope without calendar.events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: "tok",
            refresh_token: "refresh",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/userinfo.email",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(exchangeGoogleCalendarCode({} as never, "manager-1", "code", "https://app.example.com")).rejects.toThrow(
      /Calendar permission/i,
    );
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("accepts a full grant that includes calendar.events", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url).includes("token")) {
        return new Response(
          JSON.stringify({
            access_token: "tok",
            refresh_token: "refresh",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ email: "manager@example.test" }), { status: 200 });
    }));

    await expect(exchangeGoogleCalendarCode({} as never, "manager-1", "code", "https://app.example.com")).resolves.toBeDefined();
    expect(settings.save).toHaveBeenCalledWith({}, "manager-1", expect.objectContaining({ connected: true }));
  });

  it("accepts a token response that omits scope entirely (not evidence of a narrower grant)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url).includes("token")) {
        return new Response(JSON.stringify({ access_token: "tok", refresh_token: "refresh", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ email: "manager@example.test" }), { status: 200 });
    }));

    await expect(exchangeGoogleCalendarCode({} as never, "manager-1", "code", "https://app.example.com")).resolves.toBeDefined();
  });
});
