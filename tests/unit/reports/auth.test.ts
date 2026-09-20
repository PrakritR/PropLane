import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const profileRoles = vi.fn();
const profileSelect = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: profileSelect,
            }),
          }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: () => ({
            eq: () => profileRoles(),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  })),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn(async () => false),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
}));

describe("getReportsAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "dual@example.com", user_metadata: {} } },
    });
    profileSelect.mockResolvedValue({
      data: { email: "dual@example.com", role: "manager" },
    });
    profileRoles.mockResolvedValue({
      data: [{ role: "manager" }, { role: "resident" }],
    });
  });

  it("prefers resident role for resident financial reports when user has both roles", async () => {
    const { getReportsAuthContext } = await import("@/lib/reports/auth");
    const ctx = await getReportsAuthContext({ preferRole: "resident" });
    expect(ctx?.role).toBe("resident");
  });

  it("defaults dual-role users to manager when no preference is set", async () => {
    const { getReportsAuthContext } = await import("@/lib/reports/auth");
    const ctx = await getReportsAuthContext();
    expect(ctx?.role).toBe("manager");
  });

  it("prefers manager role for manager financial reports when user has both roles", async () => {
    const { getReportsAuthContext } = await import("@/lib/reports/auth");
    const ctx = await getReportsAuthContext({ preferRole: "manager" });
    expect(ctx?.role).toBe("manager");
  });

  it("resolves a vendor-only user to the vendor context", async () => {
    profileSelect.mockResolvedValue({ data: { email: "vendor@example.com", role: "vendor" } });
    profileRoles.mockResolvedValue({ data: [{ role: "vendor" }] });
    const { getReportsAuthContext } = await import("@/lib/reports/auth");
    const ctx = await getReportsAuthContext();
    expect(ctx?.role).toBe("vendor");
    expect(ctx?.userId).toBe("user-1");
  });

  it("prefers vendor role when requested and the user has it", async () => {
    profileSelect.mockResolvedValue({ data: { email: "vendor@example.com", role: "manager" } });
    profileRoles.mockResolvedValue({ data: [{ role: "manager" }, { role: "vendor" }] });
    const { getReportsAuthContext } = await import("@/lib/reports/auth");
    const ctx = await getReportsAuthContext({ preferRole: "vendor" });
    expect(ctx?.role).toBe("vendor");
  });
});

describe("assertVendorFinancialsAccess", () => {
  const db = {} as never;

  it("allows a vendor context", async () => {
    const { assertVendorFinancialsAccess } = await import("@/lib/reports/auth");
    const result = await assertVendorFinancialsAccess({ role: "vendor", userId: "v1", email: "v@x.co", db });
    expect(result).toEqual({ ok: true });
  });

  it("allows an admin context (support access)", async () => {
    const { assertVendorFinancialsAccess } = await import("@/lib/reports/auth");
    const result = await assertVendorFinancialsAccess({ role: "admin", userId: "a1", email: "a@x.co", db });
    expect(result).toEqual({ ok: true });
  });

  it("blocks a manager from reaching vendor financial reports", async () => {
    const { assertVendorFinancialsAccess } = await import("@/lib/reports/auth");
    const result = await assertVendorFinancialsAccess({ role: "manager", userId: "m1", email: "m@x.co", db });
    expect(result).toEqual({ ok: false, status: 403, error: "Forbidden." });
  });

  it("blocks a resident from reaching vendor financial reports", async () => {
    const { assertVendorFinancialsAccess } = await import("@/lib/reports/auth");
    const result = await assertVendorFinancialsAccess({ role: "resident", userId: "r1", email: "r@x.co", db });
    expect(result).toEqual({ ok: false, status: 403, error: "Forbidden." });
  });
});
