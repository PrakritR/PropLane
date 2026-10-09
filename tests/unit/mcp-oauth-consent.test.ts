import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentContext = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tools/context", () => ({ resolveAgentContext }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcp/oauth.server", () => ({
  MCP_OAUTH_SCOPE: "mcp:tools",
  verifyMcpApproval: vi.fn(() => ({
    userId: "u1",
    clientId: "c1",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: "a".repeat(43),
    scope: "mcp:tools",
    state: "s1",
    expiresAt: Date.now() + 60000,
  })),
  getMcpOAuthClient: vi.fn(async () => ({
    clientId: "c1",
    clientName: "Claude",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  })),
  createMcpAuthorizationCode: vi.fn(async () => "pl_mcp_code_test"),
  signMcpConnected: vi.fn((payload: { destination: string }) => `signed:${encodeURIComponent(payload.destination)}`),
}));

import { POST as approve } from "@/app/api/mcp/oauth/approve/route";
import { POST as deny } from "@/app/api/mcp/oauth/deny/route";

function consentRequest(path: string): Request {
  const body = new FormData();
  body.set("approval", "x");
  return new Request(`https://prop-lane.test${path}`, { method: "POST", body });
}

describe("MCP OAuth consent redirects", () => {
  beforeEach(() => {
    resolveAgentContext.mockResolvedValue({ userId: "u1", db: {}, workspace: { id: "w1" } });
  });

  it("approve answers 303 to the PropLane connected screen, carrying the callback in a signed token", async () => {
    const res = await approve(consentRequest("/api/mcp/oauth/approve"));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "", "https://prop-lane.test");
    expect(location.origin + location.pathname).toBe("https://prop-lane.test/mcp/connected");
    const token = location.searchParams.get("t") ?? "";
    const destination = new URL(decodeURIComponent(token.replace(/^signed:/, "")));
    expect(destination.origin + destination.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(destination.searchParams.get("code")).toBe("pl_mcp_code_test");
    expect(destination.searchParams.get("state")).toBe("s1");
  });

  it("deny answers 303 with access_denied and state", async () => {
    const res = await deny(consentRequest("/api/mcp/oauth/deny"));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "", "https://prop-lane.test");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("s1");
  });

  it("signed-out approve redirects to sign-in with 303", async () => {
    resolveAgentContext.mockResolvedValue(null);
    const res = await approve(consentRequest("/api/mcp/oauth/approve"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/auth\/sign-in$/);
  });
});
