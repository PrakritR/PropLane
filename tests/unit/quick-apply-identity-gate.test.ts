import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), decision: vi.fn() }));
vi.mock("@/lib/resident-identity/baseline.server", () => ({ resolveBaselineResidentIdentity: mocks.decision }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user", email: "user@example.test" } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "resident", email: "user@example.test" } }) }) }) }) }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => true }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "ip", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/listing-channels/lead-source.server", () => ({ readListingSource: async () => null }));
vi.mock("@/lib/rental-application/quick-apply.server", () => ({ runQuickApply: mocks.run }));
import { POST } from "@/app/api/portal/quick-apply/route";
afterEach(() => { mocks.run.mockReset(); mocks.decision.mockReset(); });
describe("quick apply identity boundary", () => {
  it("blocks unverified submissions before writing or charging", async () => {
    mocks.decision.mockResolvedValue("required");
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ propertyId: "home" }) }));
    expect(response.status).toBe(403); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("allows read-only dry runs", async () => {
    mocks.run.mockResolvedValue({ status: 200, body: { ready: true } });
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ dryRun: true }) }));
    expect(response.status).toBe(200); expect(mocks.decision).not.toHaveBeenCalled();
  });
});
