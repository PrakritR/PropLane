import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ roles: vi.fn(), profile: vi.fn(), cookie: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: m.cookie }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/auth/server-profile", () => ({ getServerSessionProfile: m.profile }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ needsPhoneVerification: async () => false }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ from: () => ({ select: () => ({ eq: m.roles }) }) }) }));
import { getPortalAccessContext } from "@/lib/auth/portal-access";
beforeEach(() => { vi.clearAllMocks(); m.profile.mockResolvedValue({ user: { id: "subject" }, profile: { role: "manager" }, viewAs: null }); m.cookie.mockReturnValue(undefined); });
describe("portal roles", () => {
  it.each([{ data: [], error: null }, { data: null, error: { message: "unavailable" } }])("does not grant from a legacy profile on absent/unreadable stored roles", async (result) => {
    m.roles.mockResolvedValue(result);
    expect((await getPortalAccessContext()).roles).toEqual([]);
  });
  it("keeps stored multi-role access and the chosen portal", async () => {
    m.roles.mockResolvedValue({ data: [{ role: "resident" }, { role: "manager" }], error: null });
    m.cookie.mockReturnValue({ value: "resident" });
    expect(await getPortalAccessContext()).toMatchObject({ roles: ["resident", "manager"], effectiveRole: "resident" });
  });
});
