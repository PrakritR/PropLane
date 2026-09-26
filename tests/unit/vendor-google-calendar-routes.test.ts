import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

/**
 * Vendor clones of `/api/portal/google-calendar/{connect,route}` — same
 * shared OAuth machinery (api.server.ts / settings.ts operate purely on a
 * bare userId), gated on the vendor role instead of manager. These tests
 * pin the two things that matter: an unauthenticated/non-vendor caller is
 * refused, and an authorized vendor's own userId (never a manager's) is what
 * reaches the shared connection storage.
 */

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  getUser: vi.fn(),
  assertGoogleCalendarProviderAllowed: vi.fn(async () => undefined),
  buildGoogleCalendarOAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/auth?mock=1"),
  googleCalendarOAuthRedirectUri: vi.fn(() => "https://app.example.com/api/portal/google-calendar/callback"),
  stopGoogleCalendarWatch: vi.fn(async () => undefined),
  isGoogleCalendarOAuthConfigured: vi.fn(() => true),
  warmGoogleCalendarOAuthConfig: vi.fn(async () => undefined),
  isGoogleCalendarSchemaReady: vi.fn(async () => true),
  loadGoogleCalendarConnection: vi.fn(),
  saveGoogleCalendarConnection: vi.fn(),
  clearGoogleCalendarConnection: vi.fn(async () => undefined),
  googleCalendarPublicStatus: vi.fn((connection: { connected: boolean }) => ({
    connected: connection.connected,
    email: null,
    syncEnabled: false,
    configured: true,
    schemaReady: true,
    perManager: true,
    googleAuthUser: false,
  })),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: mocks.resolveVendorPortalUserId,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: mocks.getUser },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

vi.mock("@/lib/google-calendar/api.server", () => ({
  assertGoogleCalendarProviderAllowed: mocks.assertGoogleCalendarProviderAllowed,
  buildGoogleCalendarOAuthUrl: mocks.buildGoogleCalendarOAuthUrl,
  googleCalendarOAuthRedirectUri: mocks.googleCalendarOAuthRedirectUri,
  stopGoogleCalendarWatch: mocks.stopGoogleCalendarWatch,
}));

vi.mock("@/lib/google-calendar/settings", () => ({
  isGoogleCalendarOAuthConfigured: mocks.isGoogleCalendarOAuthConfigured,
  warmGoogleCalendarOAuthConfig: mocks.warmGoogleCalendarOAuthConfig,
  isGoogleCalendarSchemaReady: mocks.isGoogleCalendarSchemaReady,
  loadGoogleCalendarConnection: mocks.loadGoogleCalendarConnection,
  saveGoogleCalendarConnection: mocks.saveGoogleCalendarConnection,
  clearGoogleCalendarConnection: mocks.clearGoogleCalendarConnection,
  googleCalendarPublicStatus: mocks.googleCalendarPublicStatus,
  DEFAULT_GOOGLE_CALENDAR_CONNECTION: { connected: false, email: null, syncEnabled: false },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isGoogleCalendarOAuthConfigured.mockReturnValue(true);
  mocks.isGoogleCalendarSchemaReady.mockResolvedValue(true);
  mocks.getUser.mockResolvedValue({ data: { user: { email: "vendor@example.com" } } });
});

describe("vendor Google Calendar connect route", () => {
  it("redirects to the OAuth URL for a signed-in vendor, using the vendor's own userId", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    const { GET } = await import("@/app/api/vendor/google-calendar/connect/route");
    const res = await GET(jsonRequest("https://app.example.com/api/vendor/google-calendar/connect?origin=https://app.example.com"));

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/auth?mock=1");
    expect(mocks.buildGoogleCalendarOAuthUrl).toHaveBeenCalledWith(
      "https://app.example.com",
      "vendor-user-1",
      "/vendor/calendar",
      expect.objectContaining({ loginHint: "vendor@example.com" }),
    );
  });

  it("refuses a non-vendor / unauthenticated caller and redirects back with a reason", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 403 });
    const { GET } = await import("@/app/api/vendor/google-calendar/connect/route");
    const res = await GET(jsonRequest("https://app.example.com/api/vendor/google-calendar/connect?origin=https://app.example.com"));

    expect(res.headers.get("location")).toContain("gcal=error");
    expect(mocks.buildGoogleCalendarOAuthUrl).not.toHaveBeenCalled();
  });

  it("refuses to start OAuth when it is not configured on this server", async () => {
    mocks.isGoogleCalendarOAuthConfigured.mockReturnValue(false);
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    const { GET } = await import("@/app/api/vendor/google-calendar/connect/route");
    const res = await GET(jsonRequest("https://app.example.com/api/vendor/google-calendar/connect?origin=https://app.example.com"));

    expect(res.headers.get("location")).toContain("gcal=error");
    expect(mocks.buildGoogleCalendarOAuthUrl).not.toHaveBeenCalled();
  });
});

describe("vendor Google Calendar status route", () => {
  it("401s an unauthenticated caller without ever loading a connection", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 401 });
    const { GET } = await import("@/app/api/vendor/google-calendar/route");
    const res = await GET(jsonRequest("https://app.example.com/api/vendor/google-calendar"));
    const { status } = await parseJsonResponse(res);

    expect(status).toBe(401);
    expect(mocks.loadGoogleCalendarConnection).not.toHaveBeenCalled();
  });

  it("loads the connection keyed by the vendor's own userId, never a manager's", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    mocks.loadGoogleCalendarConnection.mockResolvedValue({ connected: true, email: "vendor@example.com" });
    const { GET } = await import("@/app/api/vendor/google-calendar/route");
    const res = await GET(jsonRequest("https://app.example.com/api/vendor/google-calendar"));
    const { status, data } = await parseJsonResponse<{ connected: boolean }>(res);

    expect(status).toBe(200);
    expect(data.connected).toBe(true);
    expect(mocks.loadGoogleCalendarConnection).toHaveBeenCalledWith(expect.anything(), "vendor-user-1");
  });

  it("disconnect stops any active watch channel then clears the vendor's own connection", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    mocks.loadGoogleCalendarConnection.mockResolvedValue({
      connected: true,
      channelId: "chan-1",
      channelResourceId: "res-1",
    });
    const { DELETE } = await import("@/app/api/vendor/google-calendar/route");
    const res = await DELETE();

    expect(res.status).toBe(200);
    expect(mocks.stopGoogleCalendarWatch).toHaveBeenCalledWith(expect.anything(), "vendor-user-1", "chan-1", "res-1");
    expect(mocks.clearGoogleCalendarConnection).toHaveBeenCalledWith(expect.anything(), "vendor-user-1");
  });

  it("PATCH toggles sync for the vendor's own connection only", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    mocks.saveGoogleCalendarConnection.mockResolvedValue({ connected: true, syncEnabled: false });
    const { PATCH } = await import("@/app/api/vendor/google-calendar/route");
    const res = await PATCH(jsonRequest("https://app.example.com/api/vendor/google-calendar", { method: "PATCH", body: { syncEnabled: false } }));

    expect(res.status).toBe(200);
    expect(mocks.saveGoogleCalendarConnection).toHaveBeenCalledWith(expect.anything(), "vendor-user-1", { syncEnabled: false });
  });

  it("PATCH with only vendorPushEnabled never resets syncEnabled back to its default", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    mocks.saveGoogleCalendarConnection.mockResolvedValue({ connected: true, syncEnabled: false, vendorPushEnabled: true });
    const { PATCH } = await import("@/app/api/vendor/google-calendar/route");
    const res = await PATCH(
      jsonRequest("https://app.example.com/api/vendor/google-calendar", { method: "PATCH", body: { vendorPushEnabled: true } }),
    );

    expect(res.status).toBe(200);
    // Only the field actually sent is touched — no `syncEnabled` key at all,
    // so a vendor who had turned sync off can flip this toggle without it
    // silently turning sync back on.
    expect(mocks.saveGoogleCalendarConnection).toHaveBeenCalledWith(expect.anything(), "vendor-user-1", { vendorPushEnabled: true });
  });

  it("PATCH with an empty body touches neither field", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    mocks.saveGoogleCalendarConnection.mockResolvedValue({ connected: true });
    const { PATCH } = await import("@/app/api/vendor/google-calendar/route");
    const res = await PATCH(jsonRequest("https://app.example.com/api/vendor/google-calendar", { method: "PATCH", body: {} }));

    expect(res.status).toBe(200);
    expect(mocks.saveGoogleCalendarConnection).toHaveBeenCalledWith(expect.anything(), "vendor-user-1", {});
  });
});
