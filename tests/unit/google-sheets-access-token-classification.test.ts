import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getGoogleSheetsAccessTokenDetailed` — the classified counterpart added so
 * the picker-token route can tell a manager "connect Google" apart from
 * "reconnect Google" apart from "Google is having trouble right now",
 * instead of collapsing every failure into one generic 401.
 */

const sheetLink = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/manager-sheet-link", () => ({
  loadGoogleSheetsConnection: sheetLink.load,
  saveGoogleSheetsConnection: sheetLink.save,
}));
vi.mock("@/lib/google-calendar/api.server", () => ({
  googleCalendarOAuthRedirectUri: () => "https://app.example.com/api/portal/google-calendar/callback",
}));
vi.mock("@/lib/google-calendar/settings", () => ({
  isGoogleCalendarOAuthConfigured: () => true,
  resolveGoogleCalendarOAuthConfig: () => ({ clientId: "client", clientSecret: "secret" }),
}));

import { getGoogleSheetsAccessTokenDetailed } from "@/lib/sheet-sync/google-sheets-auth";

const baseConnection = {
  connected: true,
  email: "manager@example.test",
  refreshToken: "refresh-token",
  accessToken: null,
  accessTokenExpiresAt: null,
};

describe("getGoogleSheetsAccessTokenDetailed", () => {
  beforeEach(() => {
    sheetLink.load.mockReset().mockResolvedValue(baseConnection);
    sheetLink.save.mockReset().mockResolvedValue(baseConnection);
    vi.unstubAllGlobals();
  });

  it("reports not_connected when there is no refresh token", async () => {
    sheetLink.load.mockResolvedValue({ ...baseConnection, connected: false, refreshToken: null });
    await expect(getGoogleSheetsAccessTokenDetailed({} as never, "manager-1")).resolves.toEqual({
      ok: false,
      accessToken: null,
      reason: "not_connected",
    });
  });

  it("returns the cached access token without a network call when still fresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sheetLink.load.mockResolvedValue({
      ...baseConnection,
      accessToken: "cached-token",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await expect(getGoogleSheetsAccessTokenDetailed({} as never, "manager-1")).resolves.toEqual({
      ok: true,
      accessToken: "cached-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the connection disconnected and reports revoked on invalid_grant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    await expect(getGoogleSheetsAccessTokenDetailed({} as never, "manager-1")).resolves.toEqual({
      ok: false,
      accessToken: null,
      reason: "revoked",
    });
    expect(sheetLink.save).toHaveBeenCalledWith(
      {},
      "manager-1",
      expect.objectContaining({ connected: false, refreshToken: null, revoked: true }),
    );
  });

  it("reports transient_error without disconnecting on an ordinary refresh failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 })));
    await expect(getGoogleSheetsAccessTokenDetailed({} as never, "manager-1")).resolves.toEqual({
      ok: false,
      accessToken: null,
      reason: "transient_error",
    });
    expect(sheetLink.save).not.toHaveBeenCalled();
  });

  it("refreshes and returns a new token on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), { status: 200 })),
    );
    sheetLink.save.mockResolvedValue({ ...baseConnection, accessToken: "fresh-token" });
    await expect(getGoogleSheetsAccessTokenDetailed({} as never, "manager-1")).resolves.toEqual({
      ok: true,
      accessToken: "fresh-token",
    });
  });
});
