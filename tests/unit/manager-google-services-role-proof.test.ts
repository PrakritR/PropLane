import { describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ status: vi.fn(), roles: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user", user_metadata: { role: "manager" } } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: m.roles }) }) }) }));
vi.mock("@/lib/auth/manager-google-services-onboarding.server", () => ({ loadGoogleServicesOnboardingStatus: m.status, dismissGoogleServicesOnboarding: vi.fn() }));
import { GET } from "@/app/api/auth/manager-google-services/route";
describe("manager Google onboarding authorization", () => {
  it("refuses a metadata-only manager role", async () => {
    m.roles.mockResolvedValue({ data: [], error: null });
    expect((await GET()).status).toBe(403);
    expect(m.status).not.toHaveBeenCalled();
  });
});
