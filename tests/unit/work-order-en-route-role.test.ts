import { describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ role: "", mark: vi.fn(async (_db: unknown, actor: { role: string }) => actor.role === "vendor" ? { ok: true, alreadyEnRoute: false, workOrder: {} } : { ok: false, status: 403, error: "Forbidden." }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "subject", email: "x@example.test", user_metadata: { role: "vendor" } } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "vendor", email: "x@example.test" } }) }) }) }) }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveSessionActorRole: async () => m.role }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }) }));
vi.mock("@/lib/work-order-en-route.server", () => ({ markVendorEnRoute: m.mark }));
import { POST } from "@/app/api/portal/work-orders/en-route/route";
const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ workOrderId: "wo" }) });
describe("vendor en route role", () => {
  it("denies legacy-only and metadata-only vendor authority", async () => { m.role = ""; expect((await POST(request())).status).toBe(403); });
  it("allows a resolved stored vendor role", async () => { m.role = "vendor"; expect((await POST(request())).status).toBe(200); });
});
