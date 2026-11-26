import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findLiveApiKey: vi.fn(),
  touchApiKey: vi.fn(),
  findLiveMcpAccessToken: vi.fn(),
  touchMcpAccessToken: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(),
  loadWorkspaces: vi.fn(),
  listViewerWorkspaces: vi.fn(),
  loadServiceStaffWorkspaces: vi.fn(),
  resolveResidentAgentContextForUser: vi.fn(),
  resolveManagerSmsAccess: vi.fn(),
}));

vi.mock("@/lib/mcp/api-keys.server", async (orig) => ({ ...(await orig<typeof import("@/lib/mcp/api-keys.server")>()), findLiveApiKey: m.findLiveApiKey, touchApiKey: m.touchApiKey }));
vi.mock("@/lib/mcp/oauth.server", async (orig) => ({ ...(await orig<typeof import("@/lib/mcp/oauth.server")>()), findLiveMcpAccessToken: m.findLiveMcpAccessToken, touchMcpAccessToken: m.touchMcpAccessToken }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: m.createSupabaseServiceRoleClient }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: m.loadWorkspaces }));
vi.mock("@/lib/workspaces/active.server", () => ({ listViewerWorkspaces: m.listViewerWorkspaces }));
vi.mock("@/lib/service/service-mode.server", () => ({ loadServiceStaffWorkspaces: m.loadServiceStaffWorkspaces }));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({ resolveManagerSmsAccess: m.resolveManagerSmsAccess }));
vi.mock("@/lib/property-owner/access.server", () => ({ withholdManagerSurface: vi.fn(async () => false) }));
vi.mock("@/lib/tools/context", () => ({ resolveAgentContext: vi.fn() }));
vi.mock("@/lib/tools/resident-context", () => ({
  resolveResidentAgentContext: vi.fn(),
  resolveResidentAgentContextForUser: m.resolveResidentAgentContextForUser,
}));

import { listManagerConnectOptions, resolveMcpTarget } from "@/lib/mcp/consent.server";
import { resolveApiKeyContext, resolveMcpBearerContext } from "@/lib/mcp/context.server";

function db(roles: string[]) {
  return {
    from(table: string) {
      const rows = table === "profile_roles" ? roles.map((role) => ({ role })) : [];
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: table === "profiles" ? { email: "staff@example.test" } : null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
      };
    },
  };
}

const ws = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, ownerUserId: "owner_1", owned: false, isDefault: false, propertyIds: [`${id}_p1`], ...over });
const bearer = new Request("https://x.test/api/mcp", { headers: { Authorization: "Bearer pl_mcp_at_x" } });

describe("MCP connection to a staffed PropLane Service workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findLiveApiKey.mockResolvedValue(null);
    m.resolveManagerSmsAccess.mockResolvedValue({ kind: "co_manager" });
    m.createSupabaseServiceRoleClient.mockReturnValue(db(["manager"]));
    m.findLiveMcpAccessToken.mockResolvedValue({ id: "t1", userId: "staff_1", scopes: ["mcp:tools"], workspaceId: "svc_1", portal: "manager", lastUsedAt: null });
  });

  it("resolves the manager context for the staffed workspace, with the seat's access, narrowed to its houses", async () => {
    m.loadWorkspaces.mockResolvedValue([ws("own_1", { owned: true, isDefault: true }), ws("svc_1", { isService: true })]);
    const result = await resolveApiKeyContext(bearer, "mcp");
    expect(result).toMatchObject({
      ok: true,
      ctx: { landlordId: "staff_1", workspace: { id: "svc_1", narrowing: true, propertyIds: ["svc_1_p1"] }, managerSmsAccess: { kind: "co_manager" } },
    });
  });

  it("a revoked seat loses the workspace on the very next request, and never falls back to the holder's own", async () => {
    m.loadWorkspaces.mockResolvedValue([ws("own_1", { owned: true, isDefault: true })]);
    const result = await resolveApiKeyContext(bearer, "mcp");
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("an unreadable workspace list refuses rather than widening", async () => {
    m.loadWorkspaces.mockRejectedValue(new Error("down"));
    expect(await resolveApiKeyContext(bearer, "mcp")).toMatchObject({ ok: false, status: 403 });
  });

  it("a resident-bound token is never a manager credential", async () => {
    m.findLiveMcpAccessToken.mockResolvedValue({ id: "t2", userId: "u1", scopes: ["mcp:tools"], workspaceId: null, portal: "resident", lastUsedAt: null });
    expect(await resolveApiKeyContext(bearer, "mcp")).toMatchObject({ ok: false, status: 401 });
  });
});

describe("the bearer resolver dispatches on the connection's portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findLiveApiKey.mockResolvedValue(null);
    m.createSupabaseServiceRoleClient.mockReturnValue(db(["resident"]));
  });

  it("a resident token yields the resident context, re-derived each request", async () => {
    m.findLiveMcpAccessToken.mockResolvedValue({ id: "t2", userId: "res_1", scopes: ["mcp:tools"], workspaceId: null, portal: "resident", lastUsedAt: null });
    m.resolveResidentAgentContextForUser.mockResolvedValue({ kind: "resident", userId: "res_1" });
    expect(await resolveMcpBearerContext(bearer)).toMatchObject({ ok: true, portal: "resident", ctx: { userId: "res_1" } });
    expect(m.resolveResidentAgentContextForUser).toHaveBeenCalledWith("res_1");
    expect(m.loadWorkspaces).not.toHaveBeenCalled();
  });

  it("a resident who lost the role loses the connection", async () => {
    m.findLiveMcpAccessToken.mockResolvedValue({ id: "t2", userId: "res_1", scopes: ["mcp:tools"], workspaceId: null, portal: "resident", lastUsedAt: null });
    m.resolveResidentAgentContextForUser.mockResolvedValue(null);
    expect(await resolveMcpBearerContext(bearer)).toMatchObject({ ok: false, status: 403 });
  });

  it("no credential is a 401 with no lookups", async () => {
    expect(await resolveMcpBearerContext(new Request("https://x.test/api/mcp"))).toMatchObject({ ok: false, status: 401 });
    expect(m.findLiveMcpAccessToken).not.toHaveBeenCalled();
  });
});

describe("the consent Workspace picker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the viewer's workspaces plus the PropLane Service workspaces they staff", async () => {
    m.listViewerWorkspaces.mockResolvedValue([ws("own_1", { owned: true }), ws("svc_1", { isService: true })]);
    m.loadServiceStaffWorkspaces.mockResolvedValue([{ id: "svc_1", name: "Ambika", city: null, ownerUserId: "owner_1" }, { id: "svc_2", name: "Vinod", city: null, ownerUserId: "owner_1" }]);
    m.loadWorkspaces.mockResolvedValue([ws("own_1"), ws("svc_1"), ws("svc_2")]);
    const options = await listManagerConnectOptions({} as never, "staff_1");
    expect(options.map((o) => o.value)).toEqual(["ws:own_1", "ws:svc_1", "ws:svc_2"]);
    expect(options.find((o) => o.value === "ws:svc_2")).toMatchObject({ service: true, label: "Vinod (PropLane Service)" });
  });

  it("does not offer a staffed workspace the strict resolver would later refuse", async () => {
    m.listViewerWorkspaces.mockResolvedValue([ws("own_1", { owned: true })]);
    m.loadServiceStaffWorkspaces.mockResolvedValue([{ id: "svc_9", name: "Gone", city: null, ownerUserId: "o" }]);
    m.loadWorkspaces.mockResolvedValue([ws("own_1")]);
    expect((await listManagerConnectOptions({} as never, "u")).map((o) => o.value)).toEqual(["ws:own_1"]);
  });

  it("drops a service workspace it cannot vouch for when the staff read fails", async () => {
    m.listViewerWorkspaces.mockResolvedValue([ws("own_1", { owned: true }), ws("svc_1", { isService: true })]);
    m.loadServiceStaffWorkspaces.mockRejectedValue(new Error("down"));
    m.loadWorkspaces.mockResolvedValue([]);
    expect((await listManagerConnectOptions({} as never, "u")).map((o) => o.value)).toEqual(["ws:own_1"]);
  });

  it("re-derives the posted choice: a made-up workspace id or a lapsed resident role is refused", async () => {
    m.listViewerWorkspaces.mockResolvedValue([ws("own_1", { owned: true })]);
    m.loadServiceStaffWorkspaces.mockResolvedValue([]);
    expect(await resolveMcpTarget({} as never, "u", "ws:own_1")).toMatchObject({ portal: "manager", workspaceId: "own_1" });
    expect(await resolveMcpTarget({} as never, "u", "ws:someone_elses")).toBeNull();
    expect(await resolveMcpTarget({} as never, "u", "garbage")).toBeNull();
    m.resolveResidentAgentContextForUser.mockResolvedValue(null);
    expect(await resolveMcpTarget({} as never, "u", "resident")).toBeNull();
    m.resolveResidentAgentContextForUser.mockResolvedValue({ kind: "resident" });
    expect(await resolveMcpTarget({} as never, "u", "resident")).toEqual({ portal: "resident" });
  });
});
