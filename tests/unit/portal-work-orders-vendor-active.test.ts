import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ context: null as unknown, role: "denied", user: { id: "u1", email: "u@example.test" }, reads: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => h.context }));
vi.mock("@/lib/auth/resident-role-access", () => ({ resolveResidentScopedActorRole: async () => h.role }));
vi.mock("@/lib/auth/admin-oversight.server", () => ({ resolveAdminOversight: async () => false }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/work-order-manager-names.server", () => ({ attachManagerNamesToWorkOrders: async (_db: unknown, rows: unknown) => rows }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  h.reads.push(table);
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) q[method] = () => q;
  q.maybeSingle = async () => ({ data: { role: "resident", email: h.user.email }, error: null });
  q.then = (resolve: (result: unknown) => unknown) => resolve({ data: [], error: null });
  return q;
} }) }));
import { GET, POST } from "@/app/api/portal-work-orders/route";

beforeEach(() => { h.context = null; h.role = "denied"; h.reads = []; });
describe("active vendor service scope", () => {
  it.each([["vendor"], ["manager", "vendor"], ["resident", "vendor"]])("allows stored %j vendor scope but forbids writes", async (...roles) => {
    h.context = { user: h.user, roles, effectiveRole: "vendor" };
    h.role = roles.includes("resident") ? "resident" : "denied";
    expect((await GET(new Request("http://localhost/api/portal-work-orders"))).status).toBe(200);
    expect(h.reads).toContain("work_order_vendor_offers");
    expect((await POST(new Request("http://localhost/api/portal-work-orders", { method: "POST" }))).status).toBe(403);
  });
  it.each([
    { user: h.user, roles: [], effectiveRole: "vendor" },
    { user: { id: "other" }, roles: ["vendor"], effectiveRole: "vendor" },
    { user: h.user, roles: ["vendor", "resident"], effectiveRole: "resident" },
    { user: h.user, roles: ["vendor", "manager"], effectiveRole: "manager" },
  ])("never chooses vendor scope from mismatched or inactive context", async (context) => {
    h.context = context;
    expect((await GET(new Request("http://localhost/api/portal-work-orders"))).status).toBe(403);
    expect(h.reads).not.toContain("work_order_vendor_offers");
  });
});
