import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveAgentContext, verifyMcpApproval, getMcpOAuthClient } = vi.hoisted(() => ({
  resolveAgentContext: vi.fn(),
  verifyMcpApproval: vi.fn(),
  getMcpOAuthClient: vi.fn(),
}));

vi.mock("@/lib/tools/context", () => ({ resolveAgentContext }));
vi.mock("@/lib/mcp/oauth.server", () => ({ verifyMcpApproval, getMcpOAuthClient }));

import { POST } from "@/app/api/mcp/oauth/deny/route";

describe("MCP OAuth denial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentContext.mockResolvedValue({ userId: "manager_1", db: {} });
    verifyMcpApproval.mockReturnValue({
      userId: "manager_1",
      clientId: "client_1",
      redirectUri: "http://localhost:4317/callback?preserved=yes",
      state: "client-state",
    });
    getMcpOAuthClient.mockResolvedValue({ redirectUris: ["http://localhost:4317/callback?preserved=yes"] });
  });

  it("returns OAuth access_denied and preserves client state", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/mcp/oauth/deny", {
        method: "POST",
        body: new URLSearchParams({ approval: "signed" }),
      }),
    );

    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.searchParams.get("error")).toBe("access_denied");
    expect(destination.searchParams.get("state")).toBe("client-state");
    expect(destination.searchParams.get("preserved")).toBe("yes");
  });
});
