import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPortalAccessContext: vi.fn(),
  getEffectiveUserIdForPortal: vi.fn(),
  getAdminPreviewFromCookies: vi.fn(),
  isAdminUser: vi.fn(),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: mocks.getPortalAccessContext,
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
}));

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveUserIdForPortal: mocks.getEffectiveUserIdForPortal,
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  getAdminPreviewFromCookies: mocks.getAdminPreviewFromCookies,
  isAdminUser: mocks.isAdminUser,
}));

import { resolvePortalApiActorRole, resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";

describe("resolvePortalApiActorRole", () => {
  it("prefers the active portal cookie role for multi-role users", () => {
    expect(
      resolvePortalApiActorRole({
        effectiveRole: "vendor",
        roles: ["manager", "vendor"],
        profile: { role: "manager" } as { role: string | null },
      }),
    ).toBe("vendor");
  });

  it("falls back to the sole profile role", () => {
    expect(
      resolvePortalApiActorRole({
        effectiveRole: null,
        roles: ["vendor"],
        profile: { role: "manager" } as { role: string | null },
      }),
    ).toBe("vendor");
  });

  it("denies ambiguous multiple roles without an active portal", () => {
    expect(
      resolvePortalApiActorRole({
        effectiveRole: null,
        roles: ["manager", "vendor"],
        profile: { role: "manager" } as { role: string | null },
      }),
    ).toBe("");
  });
});

describe("resolveVendorPortalUserId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveUserIdForPortal.mockResolvedValue(null);
    mocks.getAdminPreviewFromCookies.mockResolvedValue(null);
    mocks.isAdminUser.mockResolvedValue(false);
  });

  it("returns the effective vendor id for multi-role users", async () => {
    mocks.getPortalAccessContext.mockResolvedValue({
      user: { id: "user-1", email: "dual@example.com" },
      profile: { role: "manager", email: "dual@example.com", full_name: "Dual User" },
      roles: ["manager", "vendor"],
      effectiveRole: "vendor",
    });
    mocks.getEffectiveUserIdForPortal.mockResolvedValue("user-1");

    const result = await resolveVendorPortalUserId();
    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  it("returns admin preview target when previewing a vendor portal", async () => {
    mocks.getPortalAccessContext.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.com" },
      profile: { role: "admin", email: "admin@example.com", full_name: "Admin" },
      roles: ["admin"],
      effectiveRole: null,
    });
    mocks.isAdminUser.mockResolvedValue(true);
    mocks.getAdminPreviewFromCookies.mockResolvedValue({ portal: "vendor", targetUserId: "vendor-9" });
    mocks.getEffectiveUserIdForPortal.mockResolvedValue("vendor-9");

    const result = await resolveVendorPortalUserId();
    expect(result).toEqual({ ok: true, userId: "vendor-9" });
  });

  it("returns 403 when caller is not a vendor and not previewing one", async () => {
    mocks.getPortalAccessContext.mockResolvedValue({
      user: { id: "mgr-1", email: "mgr@example.com" },
      profile: { role: "manager", email: "mgr@example.com", full_name: "Manager" },
      roles: ["manager"],
      effectiveRole: "manager",
    });

    const result = await resolveVendorPortalUserId();
    expect(result).toEqual({ ok: false, status: 403 });
  });
});
