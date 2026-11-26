import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolveMcpBearerContext: vi.fn(),
  loadMcpConsent: vi.fn(),
  resolveMcpTarget: vi.fn(),
  createMcpAuthorizationCode: vi.fn(),
  registerMcpOAuthClient: vi.fn(),
  exchangeMcpAuthorizationCode: vi.fn(),
}));

vi.mock("@/lib/mcp/context.server", () => ({ resolveMcpBearerContext: m.resolveMcpBearerContext }));
vi.mock("@/lib/mcp/gateway", () => ({ listTools: () => [], callTool: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock("@/lib/mcp/resident-gateway", () => ({ listResidentTools: () => [], callResidentTool: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock("@/lib/mcp/consent.server", () => ({ loadMcpConsent: m.loadMcpConsent, resolveMcpTarget: m.resolveMcpTarget }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/mcp/oauth.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp/oauth.server")>()),
  createMcpAuthorizationCode: m.createMcpAuthorizationCode,
  registerMcpOAuthClient: m.registerMcpOAuthClient,
  exchangeMcpAuthorizationCode: m.exchangeMcpAuthorizationCode,
  verifyMcpApproval: () => ({ userId: "u1", clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: "a".repeat(43), scope: "mcp:tools", state: "s", expiresAt: Date.now() + 60_000 }),
  getMcpOAuthClient: async () => ({ clientId: "c1", clientName: "Claude", redirectUris: ["https://claude.ai/cb"] }),
  signMcpConnected: () => "signed",
}));

import { POST as mcp } from "@/app/api/mcp/route";
import { POST as register } from "@/app/api/mcp/oauth/register/route";
import { POST as token } from "@/app/api/mcp/oauth/token/route";
import { POST as approve } from "@/app/api/mcp/oauth/approve/route";
import { MCP_LIMITS } from "@/lib/mcp/rate-limits";

let n = 0;
const ip = () => `203.0.113.${(n += 1) % 250}`;
function rpc(method: string, headers: Record<string, string>, id: number | undefined = 1) {
  return new Request("https://proplane.ai/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method }),
  });
}

describe("MCP rate limits fit a normal Claude client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("an unauthenticated probe is a free 401 that never spends a limit", async () => {
    m.resolveMcpBearerContext.mockResolvedValue({ ok: false, status: 401, error: "Missing API key." });
    const address = ip();
    for (let i = 0; i < 200; i++) {
      const res = await mcp(rpc("initialize", { "x-forwarded-for": address }));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
    }
  });

  it("a whole connect (initialize, initialized, tools/list, calls) from a shared address is never refused", async () => {
    m.resolveMcpBearerContext.mockResolvedValue({ ok: true, portal: "manager", keyId: "oauth:shared", allowedTools: [], scopes: ["mcp:tools"], ctx: {} });
    const address = ip();
    const steps = [rpc("initialize", { Authorization: "Bearer t", "x-forwarded-for": address }), rpc("notifications/initialized", { Authorization: "Bearer t", "x-forwarded-for": address }, undefined), rpc("tools/list", { Authorization: "Bearer t", "x-forwarded-for": address })];
    for (let i = 0; i < 10; i++) steps.push(rpc("ping", { Authorization: "Bearer t", "x-forwarded-for": address }, 10 + i));
    for (const req of steps) expect([200, 202]).toContain((await mcp(req)).status);
  });

  it("many different grants behind one address (Claude's shared egress) do not starve each other", async () => {
    const address = ip();
    for (let grant = 0; grant < 40; grant++) {
      m.resolveMcpBearerContext.mockResolvedValue({ ok: true, portal: "manager", keyId: `oauth:g${address}:${grant}`, allowedTools: [], scopes: ["mcp:tools"], ctx: {} });
      for (let call = 0; call < 5; call++) expect((await mcp(rpc("ping", { Authorization: "Bearer t", "x-forwarded-for": address }))).status).toBe(200);
    }
  });

  it("one grant is still braked per minute", async () => {
    m.resolveMcpBearerContext.mockResolvedValue({ ok: true, portal: "manager", keyId: `oauth:abusive${ip()}`, allowedTools: [], scopes: ["mcp:tools"], ctx: {} });
    const address = ip();
    let refused = 0;
    for (let i = 0; i < MCP_LIMITS.callsPerGrant + 5; i++) {
      const res = await mcp(rpc("ping", { Authorization: "Bearer t", "x-forwarded-for": address }));
      if (res.status === 429) {
        refused += 1;
        expect(res.headers.get("retry-after")).toBe("60");
      }
    }
    expect(refused).toBe(5);
  });

  it("failed credentials from one address are braked, and only failures count", async () => {
    m.resolveMcpBearerContext.mockResolvedValue({ ok: false, status: 401, error: "Invalid or revoked API key." });
    const address = ip();
    const statuses: number[] = [];
    for (let i = 0; i < MCP_LIMITS.authFailuresPerIp + 3; i++) {
      statuses.push((await mcp(rpc("ping", { Authorization: "Bearer guess", "x-forwarded-for": address }))).status);
    }
    expect(statuses.slice(0, MCP_LIMITS.authFailuresPerIp).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(MCP_LIMITS.authFailuresPerIp)).toEqual([429, 429, 429]);
  });

  it("registration fits a connect from a shared address and is still braked", async () => {
    m.registerMcpOAuthClient.mockResolvedValue({ clientId: "c", clientName: "Claude", redirectUris: ["https://claude.ai/cb"] });
    const address = ip();
    const req = () => new Request("https://proplane.ai/api/mcp/oauth/register", { method: "POST", headers: { "x-forwarded-for": address }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] }) });
    const statuses: number[] = [];
    for (let i = 0; i < MCP_LIMITS.registerPerIp + 2; i++) statuses.push((await register(req())).status);
    expect(statuses.slice(0, MCP_LIMITS.registerPerIp).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(MCP_LIMITS.registerPerIp)).toEqual([429, 429]);
  });

  it("token exchanges and refreshes fit, per address and per client", async () => {
    m.exchangeMcpAuthorizationCode.mockResolvedValue({ accessToken: "a", refreshToken: "r", scopes: ["mcp:tools"] });
    const address = ip();
    const req = (clientId: string) => {
      const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: "c", redirect_uri: "https://claude.ai/cb", code_verifier: "v" });
      return new Request("https://proplane.ai/api/mcp/oauth/token", { method: "POST", headers: { "x-forwarded-for": address, "content-type": "application/x-www-form-urlencoded" }, body: form });
    };
    for (let i = 0; i < MCP_LIMITS.tokenPerClient; i++) expect((await token(req(`client_${address}`))).status).toBe(200);
    expect((await token(req(`client_${address}`))).status).toBe(429);
    expect((await token(req(`other_${address}`))).status).toBe(200);
  });
});

describe("the consent choice becomes the connection's portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.loadMcpConsent.mockResolvedValue({ userId: "u1", db: {}, defaultValue: "ws:w1" });
    m.createMcpAuthorizationCode.mockResolvedValue("pl_mcp_code_x");
  });
  const post = (target?: string) => {
    const body = new FormData();
    body.set("approval", "x");
    if (target) body.set("target", target);
    return approve(new Request("https://proplane.ai/api/mcp/oauth/approve", { method: "POST", body }));
  };

  it("As resident mints a resident connection with no workspace", async () => {
    m.resolveMcpTarget.mockResolvedValue({ portal: "resident" });
    expect((await post("resident")).status).toBe(303);
    expect(m.resolveMcpTarget).toHaveBeenCalledWith(expect.anything(), "u1", "resident");
    expect(m.createMcpAuthorizationCode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ portal: "resident", workspaceId: null }));
  });

  it("a staffed workspace mints a manager connection for exactly that workspace", async () => {
    m.resolveMcpTarget.mockResolvedValue({ portal: "manager", workspaceId: "svc_1", workspaceName: "Ambika (PropLane Service)" });
    await post("ws:svc_1");
    expect(m.createMcpAuthorizationCode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ portal: "manager", workspaceId: "svc_1" }));
  });

  it("nothing posted means the workspace the person has open", async () => {
    m.resolveMcpTarget.mockResolvedValue({ portal: "manager", workspaceId: "w1", workspaceName: "Main" });
    await post();
    expect(m.resolveMcpTarget).toHaveBeenCalledWith(expect.anything(), "u1", "ws:w1");
  });

  it("a choice that does not resolve right now mints nothing", async () => {
    m.resolveMcpTarget.mockResolvedValue(null);
    expect((await post("ws:forged")).status).toBe(400);
    expect(m.createMcpAuthorizationCode).not.toHaveBeenCalled();
  });
});
