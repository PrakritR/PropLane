import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveAgentContext, listApiKeys, rateLimit } = vi.hoisted(() => ({
  resolveAgentContext: vi.fn(),
  listApiKeys: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true })),
}));

vi.mock("@/lib/tools/context", () => ({ resolveAgentContext }));
vi.mock("@/lib/mcp/api-keys.server", () => ({
  listApiKeys,
  mintApiKey: vi.fn(),
  normalizeAllowedTools: vi.fn(() => []),
  normalizeScopes: vi.fn(() => []),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcp/capabilities", () => ({ API_KEY_WRITE_TOOL_NAMES: new Set(), productAreaSelectionsForTools: vi.fn(() => []) }));

import { POST } from "@/app/api/manager/api-keys/route";

describe("manager API-key route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentContext.mockResolvedValue({ userId: "manager_1", db: {} });
    listApiKeys.mockResolvedValue([]);
    rateLimit.mockReturnValue({ ok: true });
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
});
