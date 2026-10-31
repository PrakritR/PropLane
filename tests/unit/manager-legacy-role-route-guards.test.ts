import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ roles: [] as string[], error: false, purge: vi.fn(async () => ({ deleted: 0, purgedEmails: [], deletedApplicationIds: [] })), globalPurge: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user", user_metadata: { role: "manager" } } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: state.roles.map((role) => ({ role })), error: state.error ? { message: "unavailable" } : null }) }) }) }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }) }));
vi.mock("@/lib/auth/purge-manager-resident-orphans", () => ({ purgeManagerResidentOrphans: state.purge }));
vi.mock("@/lib/auth/purge-orphaned-portal-records", () => ({ purgeOrphanedPortalRecords: state.globalPurge }));
import { POST } from "@/app/api/portal/purge-orphaned-records/route";
const req = (mode: string) => new Request("https://example.test", { method: "POST", body: JSON.stringify({ mode }) });
beforeEach(() => { state.roles = []; state.error = false; state.purge.mockClear(); state.globalPurge.mockClear(); });
describe("manager purge authorization", () => {
  it("refuses forged metadata and unreadable role state", async () => {
    expect((await POST(req("current_only"))).status).toBe(403);
    state.roles = ["manager"]; state.error = true; expect((await POST(req("current_only"))).status).toBe(403);
    expect(state.purge).not.toHaveBeenCalled();
  });
  it("scopes a stored manager to their own records", async () => {
    state.roles = ["resident", "manager"]; expect((await POST(req("current_only"))).status).toBe(200);
    expect(state.purge).toHaveBeenCalledWith(expect.anything(), "user", { currentOnly: true });
    expect((await POST(req("admin_global"))).status).toBe(403);
  });
  it("permits a stored admin's explicit global mode", async () => {
    state.roles = ["admin"]; expect((await POST(req("admin_global"))).status).toBe(200); expect(state.globalPurge).toHaveBeenCalledTimes(1);
  });
});
