import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ roles: [] as string[], error: false, tables: [] as string[] }));
vi.mock("@/lib/admin/admin-account-detail.server", () => ({ isAdminAccountId: () => true }));
vi.mock("@/lib/admin/admin-route-guard.server", () => ({ requireAdminRoute: async () => ({ ok: true, userId: "admin" }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  state.tables.push(table);
  return { select: () => ({ eq: async () => ({ data: state.roles.map(role => ({ role })), error: state.error ? { message: "unavailable" } : null }) }) };
} }) }));
import { resolveAdminBillingTarget } from "@/lib/admin/admin-account-billing-route.server";
const call = () => resolveAdminBillingTarget(new Request("https://example.test", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "target" }) });
beforeEach(() => { state.roles = []; state.error = false; state.tables = []; });
describe("admin billing target role", () => {
  it("denies a legacy-only manager without consulting profiles", async () => {
    const result = await call();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
    expect(state.tables).toEqual(["profile_roles"]);
  });
  it("accepts a stored manager among multiple roles", async () => {
    state.roles = ["resident", "manager"];
    const result = await call();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.managerUserId).toBe("target");
  });
  it("fails closed when roles cannot be read", async () => {
    state.roles = ["manager"]; state.error = true;
    const result = await call();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });
});
