import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveAgentContext, listApiKeys, mintApiKey, rateLimit, listViewerWorkspaces } = vi.hoisted(() => ({
  resolveAgentContext: vi.fn(),
  listApiKeys: vi.fn(),
  mintApiKey: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true })),
  listViewerWorkspaces: vi.fn(),
}));

vi.mock("@/lib/tools/context", () => ({ resolveAgentContext }));
vi.mock("@/lib/mcp/api-keys.server", () => ({
  listApiKeys,
  mintApiKey,
  normalizeAllowedTools: vi.fn((v: unknown) => (Array.isArray(v) ? v : [])),
  normalizeScopes: vi.fn(() => []),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcp/capabilities", () => ({ API_KEY_WRITE_TOOL_NAMES: new Set(), productAreaSelectionsForTools: vi.fn(() => []) }));
vi.mock("@/lib/workspaces/active.server", () => ({ listViewerWorkspaces }));

import { POST } from "@/app/api/manager/api-keys/route";

describe("manager API-key route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentContext.mockResolvedValue({ userId: "manager_1", db: {}, workspace: { id: "ws_active" } });
    listApiKeys.mockResolvedValue([]);
    rateLimit.mockReturnValue({ ok: true });
    listViewerWorkspaces.mockResolvedValue([{ id: "ws_active" }, { id: "ws_other" }]);
    mintApiKey.mockResolvedValue({ key: { id: "key_1" }, token: "pl_live_x" });
  });

  it("refuses direct creation of static MCP bearer keys", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bypass attempt", transport: "mcp" }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/OAuth/i);
  });

  it("uses the manager-agent predicate rather than the broader portal-route guard", async () => {
    resolveAgentContext.mockResolvedValue(null);
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "No agent access", transport: "api", allowedTools: ["list_charges"] }),
      }),
    );

    expect(response.status).toBe(401);
  });

  // W001 regression: a new key used to carry no workspace at all. It must
  // now default to the active workspace of the session that created it.
  it("defaults a new key's workspace to the caller's active workspace", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Harness", transport: "api", allowedTools: ["list_charges"] }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mintApiKey).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws_active" }));
  });

  it("honors an explicit workspaceId the caller can actually select", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Harness", transport: "api", allowedTools: ["list_charges"], workspaceId: "ws_other" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mintApiKey).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws_other" }));
  });

  it("refuses a workspaceId the caller cannot select rather than silently falling back", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Harness",
          transport: "api",
          allowedTools: ["list_charges"],
          workspaceId: "ws_not_mine",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mintApiKey).not.toHaveBeenCalled();
  });
});
