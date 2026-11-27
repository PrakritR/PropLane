import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A Google Calendar connection is only real once PropLane holds a refresh token.
 * Production had a dozen manager rows with an access token, no refresh token and
 * `connected: false`: Google sign-in handed over a short-lived token, the link
 * saved it and reported "linked", and the dedicated Calendar consent never ran.
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

import { exchangeGoogleCalendarCode } from "@/lib/google-calendar/api.server";
import {
  maybeLinkGoogleCalendarFromOAuthSession,
  shouldRedirectToGoogleCalendarConnect,
} from "@/lib/google-calendar/link-from-auth.server";
import type { Session, User } from "@supabase/supabase-js";

const disconnected = {
  connected: false,
  email: null,
  syncEnabled: true,
  refreshToken: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  calendarId: "primary",
};

function managerDb() {
  return {
    from: () => ({
      select: () => ({ eq: async () => ({ data: [{ role: "manager" }], error: null }) }),
    }),
  } as never;
}

const googleManager = { id: "manager-000001", email: "manager@example.test", app_metadata: { provider: "google" } } as unknown as User;

describe("Google sign-in never counts as a calendar connection without a refresh token", () => {
  beforeEach(() => {
    settings.load.mockReset().mockResolvedValue(disconnected);
    settings.save.mockReset().mockResolvedValue(disconnected);
  });

  it("does not save a sign-in access token and reports not linked", async () => {
    const session = { provider_token: "sign-in-token", provider_refresh_token: null, expires_at: 1 } as unknown as Session;
    const result = await maybeLinkGoogleCalendarFromOAuthSession(managerDb(), googleManager, session, { intent: "manager" });
    expect(result).toEqual({ linked: false, reason: "no_refresh_token" });
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("sends that manager on to the dedicated Calendar consent", () => {
    expect(
      shouldRedirectToGoogleCalendarConnect({
        linkResult: { linked: false, reason: "no_refresh_token" },
        resolvedPath: "/portal/dashboard",
        intent: "manager",
        nextPath: null,
        googleAuthUser: true,
        calendarOAuthConfigured: true,
      }),
    ).toBe(true);
  });

  it("still links when the sign-in did carry a refresh token", async () => {
    const session = { provider_token: "tok", provider_refresh_token: "refresh", expires_at: 1 } as unknown as Session;
    const result = await maybeLinkGoogleCalendarFromOAuthSession(managerDb(), googleManager, session, { intent: "manager" });
    expect(result).toEqual({ linked: true, reason: "linked" });
    expect(settings.save).toHaveBeenCalledWith(
      expect.anything(),
      "manager-000001",
      expect.objectContaining({ connected: true, refreshToken: "refresh" }),
    );
  });
});

describe("Calendar consent without a refresh token fails loudly", () => {
  beforeEach(() => {
    settings.load.mockReset().mockResolvedValue(disconnected);
    settings.save.mockReset().mockResolvedValue(disconnected);
    vi.unstubAllGlobals();
  });

  function stubGoogle(token: Record<string, unknown>) {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url).includes("token")) return new Response(JSON.stringify(token), { status: 200 });
      return new Response(JSON.stringify({ email: "manager@example.test" }), { status: 200 });
    }));
  }

  it("refuses to save a connection that cannot refresh", async () => {
    stubGoogle({ access_token: "tok", expires_in: 3600 });
    await expect(
      exchangeGoogleCalendarCode({} as never, "manager-1", "code", "https://app.example.com"),
    ).rejects.toThrow(/lasting access/);
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("keeps an existing refresh token when Google omits a new one on reconnect", async () => {
    settings.load.mockResolvedValue({ ...disconnected, connected: true, refreshToken: "kept" });
    stubGoogle({ access_token: "tok", expires_in: 3600 });
    await exchangeGoogleCalendarCode({} as never, "manager-1", "code", "https://app.example.com");
    expect(settings.save).toHaveBeenCalledWith(
      {},
      "manager-1",
      expect.objectContaining({ connected: true, refreshToken: "kept" }),
    );
  });
});
