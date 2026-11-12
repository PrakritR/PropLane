import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getUser = vi.fn();
const getRequestUserFast = vi.fn();
const resolveAuthenticatedBusinessAccess = vi.fn();
const userHoldsAdminRoleStrict = vi.fn();
const loadServiceStaffWorkspaces = vi.fn();
const managerRow = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: (...a: unknown[]) => getUser(...a) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve(managerRow()),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/auth/request-user-fast.server", () => ({ getRequestUserFast: (...a: unknown[]) => getRequestUserFast(...a) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: (...a: unknown[]) => resolveAuthenticatedBusinessAccess(...a),
}));
vi.mock("@/lib/auth/admin-role", () => ({ userHoldsAdminRoleStrict: (...a: unknown[]) => userHoldsAdminRoleStrict(...a) }));
vi.mock("@/lib/service/service-mode.server", () => ({
  loadServiceStaffWorkspaces: (...a: unknown[]) => loadServiceStaffWorkspaces(...a),
}));
vi.mock("@/lib/property-owner/access.server", () => ({ withholdManagerSurface: async () => false }));

import { resolveManagerRouteActor } from "@/lib/auth/route-actor.server";

const USER = { id: "user-1", email: "a@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getUser.mockResolvedValue({ data: { user: USER }, error: null });
  getRequestUserFast.mockResolvedValue(null);
  resolveAuthenticatedBusinessAccess.mockResolvedValue({ kind: "normal" });
  managerRow.mockReturnValue({ data: { role: "manager" }, error: null });
  userHoldsAdminRoleStrict.mockResolvedValue(false);
  loadServiceStaffWorkspaces.mockResolvedValue([]);
});

describe("resolveManagerRouteActor", () => {
  it("passes a manager", async () => {
    const r = await resolveManagerRouteActor();
    expect(r).toMatchObject({ ok: true, userId: "user-1" });
  });

  it("answers 503, not 401, on a GoTrue 5xx (after one retry)", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 502, name: "AuthApiError" } });
    const r = await resolveManagerRouteActor({ route: "t" });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("retries AuthRetryableFetchError once then 503", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } });
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: false, status: 503 });
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("treats an error without a status as retryable", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: "Error" } });
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: false, status: 503 });
  });

  it("succeeds when getUser fails once then works", async () => {
    getUser
      .mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } })
      .mockResolvedValueOnce({ data: { user: USER }, error: null });
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: true, userId: "user-1" });
  });

  it("answers 401 'Sign in again.' with no session", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await resolveManagerRouteActor()).toEqual({ ok: false, status: 401, error: "Sign in again." });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("answers 401 on a 4xx auth error", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 401, name: "AuthApiError" } });
    expect(await resolveManagerRouteActor()).toEqual({ ok: false, status: 401, error: "Sign in again." });
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 403, name: "AuthApiError" } });
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 503 when the role read errors", async () => {
    managerRow.mockReturnValue({ data: null, error: { message: "boom" } });
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: false, status: 503 });
  });

  it("passes an admin with an accepted seat and no manager row", async () => {
    managerRow.mockReturnValue({ data: null, error: null });
    userHoldsAdminRoleStrict.mockResolvedValue(true);
    loadServiceStaffWorkspaces.mockResolvedValue([{ id: "ws", ownerUserId: "o" }]);
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: true, userId: "user-1" });
  });

  it("passes a non-admin holder of a service seat with no manager row", async () => {
    managerRow.mockReturnValue({ data: null, error: null });
    loadServiceStaffWorkspaces.mockResolvedValue([{ id: "ws", ownerUserId: "o" }]);
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: true });
  });

  it("refuses 403 with no manager row, no admin, no seat", async () => {
    managerRow.mockReturnValue({ data: null, error: null });
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: false, status: 403, error: "Manager access required." });
  });

  it("answers 503 when the seat read throws", async () => {
    managerRow.mockReturnValue({ data: null, error: null });
    loadServiceStaffWorkspaces.mockRejectedValue(new Error("x"));
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: false, status: 503 });
  });

  it("answers 403 when business access is denied", async () => {
    resolveAuthenticatedBusinessAccess.mockResolvedValue({ kind: "denied" });
    expect(await resolveManagerRouteActor()).toMatchObject({ ok: false, status: 403 });
  });

  it("logs one line per refusal without an email", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await resolveManagerRouteActor({ route: "r" });
    const spy = console.error as unknown as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain("@");
  });
});
