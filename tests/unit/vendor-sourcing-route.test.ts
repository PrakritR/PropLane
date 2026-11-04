import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), business: vi.fn(), db: vi.fn(), settings: vi.fn(), sweep: vi.fn() }));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: mocks.access }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: mocks.business }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.db }));
vi.mock("@/lib/vendor-dispatch-settings", () => ({ loadVendorDispatchSettings: mocks.settings }));
vi.mock("@/lib/vendor-sourcing.server", () => ({ sweepVendorSourcing: mocks.sweep }));
import { GET, POST } from "@/app/api/portal/vendor-sourcing/route";
const calls: { table: string; operation: string; filters: [string, unknown][]; payload?: unknown }[] = [];
function database(owner = "owner") {
  return { rpc: async (name: string, args: unknown) => { calls.push({ table: name, operation: "rpc", filters: [], payload: args }); return { data: true, error: null }; }, from(table: string) {
    const call = { table, operation: "read", filters: [] as [string, unknown][], payload: undefined as unknown }; calls.push(call);
    const result = () => ({ data: table === "portal_work_order_records" && call.filters.some(([key,value]) => key === "manager_user_id" && value === owner) ? { id: "service", manager_user_id: owner, resident_email: "resident@test.invalid", row_data: { bucket: "open" } } : null, error: null });
    const q = { select: () => q, eq: (key: string, value: unknown) => { call.filters.push([key,value]); return q; }, order: () => q, not: () => q, update: (payload: unknown) => { call.operation="update";call.payload=payload;return q; }, upsert: (payload: unknown) => { call.operation="upsert";call.payload=payload;return q; }, maybeSingle: async () => result(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
    return q;
  } };
}
const url = "https://example.test/api/portal/vendor-sourcing?workOrderId=service";
const post = (action: string) => new Request(url, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({workOrderId:"service", action}) });
beforeEach(() => { vi.clearAllMocks();calls.length=0;mocks.access.mockResolvedValue({user:{id:"owner"},effectiveRole:"manager"});mocks.business.mockResolvedValue({kind:"allowed"});mocks.settings.mockResolvedValue({quoteSourcingEnabled:true});mocks.db.mockReturnValue(database()); });
describe("manager vendor sourcing route authority", () => {
  it("requires a login and manager portal role", async () => { mocks.access.mockResolvedValueOnce({user:null});expect((await GET(new Request(url))).status).toBe(401);mocks.access.mockResolvedValueOnce({user:{id:"vendor"},effectiveRole:"vendor"});expect((await GET(new Request(url))).status).toBe(403);expect(calls).toHaveLength(0); });
  it("does not disclose another manager's job or mutate it", async () => { mocks.db.mockReturnValue(database("foreign"));expect((await GET(new Request(url))).status).toBe(403);expect((await POST(post("resume"))).status).toBe(403);expect(calls.every((c) => c.table === "portal_work_order_records")).toBe(true); });
  it("shows an authorized empty service and preserves explicit off settings", async () => { const response = await GET(new Request(url));expect(response.status).toBe(200);expect(await response.json()).toEqual({job:null,candidates:[]});mocks.settings.mockResolvedValue({quoteSourcingEnabled:false});expect((await POST(post("start"))).status).toBe(409);expect(calls.every(c => c.operation === "read")).toBe(true); });
  it("pause invalidates a lease only under the authenticated owner", async () => { expect((await POST(post("pause"))).status).toBe(200);const update=calls.find(c=>c.operation==="rpc");expect(update).toMatchObject({table:"control_vendor_sourcing",payload:{p_action:"pause",p_manager_user_id:"owner",p_work_order_id:"service"}});expect(mocks.sweep).not.toHaveBeenCalled(); });
});

it("returns a conflict when a completed or stale action cannot change state", async () => {
  const db = database(); db.rpc = async () => ({ data: false, error: null }); mocks.db.mockReturnValue(db);
  expect((await POST(post("pause"))).status).toBe(409);
});
