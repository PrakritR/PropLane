// A staff-scope lookup that fails must fail the schedule GET (500), not read as "not staff" (a 200 that
// drops the staff's houses). Non-strict routes keep the fail-closed null.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  strict: vi.fn(),
  lax: vi.fn(),
}));

vi.mock("@/lib/service/service-mode.server", () => ({
  loadServiceStaffScope: mocks.lax,
  loadServiceStaffScopeOrThrow: mocks.strict,
}));
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => ({ user: { id: "u1", email: "a@b.c" }, roles: ["manager"], effectiveRole: "manager", profile: null }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/admin-oversight.server", () => ({ resolveAdminOversight: async () => false }));

const { createJsonRecordRoute } = await import("@/lib/portal-record-api");

describe("strictServiceScopeOnRead", () => {
  beforeEach(() => {
    mocks.strict.mockReset().mockRejectedValue(new Error("db down"));
    mocks.lax.mockReset().mockResolvedValue(null);
  });

  it("returns 500 when the staff scope cannot be read", async () => {
    const readRecords = vi.fn().mockResolvedValue({ data: [], error: null });
    const route = createJsonRecordRoute({ table: "t", resolveServiceScope: true, strictServiceScopeOnRead: true, readRecords } as never);
    const res = await route.GET(new Request("http://x/api"));
    expect(res.status).toBe(500);
    expect(readRecords).not.toHaveBeenCalled();
  });

  it("a route that did not opt in keeps the fail-closed null", async () => {
    const readRecords = vi.fn().mockResolvedValue({ data: [], error: null });
    const route = createJsonRecordRoute({ table: "t", resolveServiceScope: true, readRecords } as never);
    const res = await route.GET(new Request("http://x/api"));
    expect(res.status).toBe(200);
    expect(mocks.strict).not.toHaveBeenCalled();
  });
});
