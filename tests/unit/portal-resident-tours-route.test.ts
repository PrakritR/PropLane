import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getResidentTours } from "@/app/api/portal-resident-tours/route";

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveSessionForPortal: vi.fn(),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: vi.fn(),
  hasAdminRole: vi.fn(() => false),
  hasRole: vi.fn(() => false),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  getAdminPreviewFromCookies: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/auth/ensure-resident-portal-access.server", () => ({
  ensureMayAccessResidentPortal: vi.fn(),
}));
vi.mock("@/lib/tour-resident-link.server", () => ({
  loadResidentTourViews: vi.fn(),
  linkAllTourInquiriesForEmail: vi.fn(),
}));

import { ensureMayAccessResidentPortal } from "@/lib/auth/ensure-resident-portal-access.server";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { linkAllTourInquiriesForEmail, loadResidentTourViews } from "@/lib/tour-resident-link.server";

describe("GET /api/portal-resident-tours", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({} as never);
    vi.mocked(ensureMayAccessResidentPortal).mockResolvedValue({ ok: true });
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "u1" },
      profile: null,
      roles: [],
      effectiveRole: null,
    } as never);
    vi.mocked(hasRole).mockReturnValue(false);
  });

  it("denies unauthenticated callers", async () => {
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({ user: null, profile: null } as never);
    const res = await getResidentTours();
    expect(res.status).toBe(401);
    expect(loadResidentTourViews).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: "u1", email: "auth@example.com" }, "auth@example.com"],
    [{ id: "u1", email: "auth@example.com", email_confirmed_at: "confirmed" }, "other@example.com"],
  ])("does not use an unproven or mismatched profile email", async (user, email) => {
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({ user, profile: { email } } as never);
    vi.mocked(loadResidentTourViews).mockResolvedValue([] as never);
    const response = await getResidentTours();
    expect(response.status).toBe(200);
    expect(linkAllTourInquiriesForEmail).not.toHaveBeenCalled();
    expect(loadResidentTourViews).toHaveBeenCalledWith(expect.anything(), "u1", { email: "" });
  });

  it("auto-promotes signed-in managers and loads tours", async () => {
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({
      user: { id: "mgr-1", email: "mgr@example.com", email_confirmed_at: "confirmed" },
      profile: { role: "manager", email: "mgr@example.com" },
    } as never);
    vi.mocked(loadResidentTourViews).mockResolvedValue([] as never);
    const res = await getResidentTours();
    expect(res.status).toBe(200);
    expect(ensureMayAccessResidentPortal).toHaveBeenCalled();
    expect(loadResidentTourViews).toHaveBeenCalledWith(expect.anything(), "mgr-1", {
      email: "mgr@example.com",
    });
  });

  it("allows multi-role residents when profile_roles includes resident", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({} as never);
    vi.mocked(hasRole).mockImplementation((_ctx, role) => role === "resident");
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({
      user: { id: "dual-1", email: "dual@example.com", email_confirmed_at: "confirmed" },
      profile: { role: "manager", email: "dual@example.com" },
    } as never);
    vi.mocked(loadResidentTourViews).mockResolvedValue([] as never);
    const res = await getResidentTours();
    expect(res.status).toBe(200);
    expect(loadResidentTourViews).toHaveBeenCalledWith(expect.anything(), "dual-1", {
      email: "dual@example.com",
    });
  });

  it("returns only linked tours for authenticated residents", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({} as never);
    vi.mocked(hasRole).mockImplementation((_ctx, role) => role === "resident");
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({
      user: { id: "res-1", email: "res@example.com", email_confirmed_at: "confirmed" },
      profile: { role: "resident", email: "res@example.com" },
    } as never);
    vi.mocked(loadResidentTourViews).mockResolvedValue([
      { inquiryId: "inq-1", status: "pending", confirmed: false },
    ] as never);
    const res = await getResidentTours();
    expect(res.status).toBe(200);
    expect(loadResidentTourViews).toHaveBeenCalledWith(expect.anything(), "res-1", {
      email: "res@example.com",
    });
    const body = (await res.json()) as { tours: unknown[] };
    expect(body.tours).toHaveLength(1);
  });
});
