import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveApiKeyContext, rateLimit, listTools, callTool } = vi.hoisted(() => ({
  resolveApiKeyContext: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true })),
  listTools: vi.fn(() => [{ name: "get_portfolio", description: "Get the portfolio.", inputSchema: { type: "object" } }]),
  callTool: vi.fn(),
}));

vi.mock("@/lib/mcp/context.server", () => ({ resolveApiKeyContext }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "127.0.0.1", rateLimit }));
vi.mock("@/lib/mcp/gateway", () => ({ listTools, callTool }));

import { DELETE, GET, OPTIONS, POST } from "@/app/api/mcp/route";

function request(body: unknown) {
  return new Request("https://prop-lane.test/api/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer pl_live_test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("MCP JSON-RPC transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockReturnValue({ ok: true });
    resolveApiKeyContext.mockResolvedValue({
      ok: true,
      keyId: "key_1",
      scopes: ["read"],
      allowedTools: ["get_portfolio"],
      ctx: { userId: "manager_1", landlordId: "manager_1" },
    });
  });

  it("negotiates, lists tools, pings, and makes MCP tool calls", async () => {
    const initialized = await POST(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }));
    expect(initialized.status).toBe(200);
    expect((await initialized.json()).result.protocolVersion).toBe("2025-03-26");

    const listed = await POST(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect((await listed.json()).result.tools).toEqual(listTools());

    const pong = await POST(request({ jsonrpc: "2.0", id: 3, method: "ping" }));
    expect((await pong.json()).result).toEqual({});

    callTool.mockResolvedValue({ ok: true, data: { count: 1 } });
    const called = await POST(request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_portfolio", arguments: {} } }));
    const callBody = await called.json();
    expect(callTool).toHaveBeenCalledWith(expect.anything(), ["get_portfolio"], ["read"], "get_portfolio", {}, "mcp", "key_1");
    expect(callBody.result.content[0].text).toContain('"count": 1');
  });

  it("handles notifications, unknown methods, malformed requests, and the stateless verbs", async () => {
    const notification = await POST(request({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const unknown = await POST(request({ jsonrpc: "2.0", id: 7, method: "resources/list" }));
    expect((await unknown.json()).error.code).toBe(-32601);

    const malformed = await POST(request({ id: 8, method: "ping" }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe(-32600);

    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
    expect((await OPTIONS()).status).toBe(204);
  });

  it("returns bearer auth failure before parsing JSON-RPC", async () => {
    resolveApiKeyContext.mockResolvedValue({ ok: false, status: 401, error: "Invalid or revoked API key." });
    const response = await POST(request({ not: "json-rpc" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
});
