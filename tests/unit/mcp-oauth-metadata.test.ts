import { describe, expect, it, vi } from "vitest";

import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as authorizationServer } from "@/app/.well-known/oauth-authorization-server/route";
import { isSafeOAuthRedirectUri, signMcpApproval, verifyMcpApproval } from "@/lib/mcp/oauth.server";

describe("MCP OAuth discovery", () => {
  it("publishes the MCP protected-resource and OAuth server metadata", async () => {
    const req = new Request("https://prop-lane.test/api/mcp", { headers: { host: "prop-lane.test" } });
    const resource = await protectedResource(req);
    expect(await resource.json()).toMatchObject({
      resource: "https://prop-lane.test/api/mcp",
      authorization_servers: ["https://prop-lane.test"],
      scopes_supported: ["mcp:tools"],
    });
    const authorization = await authorizationServer(req);
    expect(await authorization.json()).toMatchObject({
      authorization_endpoint: "https://prop-lane.test/mcp/authorize",
      token_endpoint: "https://prop-lane.test/api/mcp/oauth/token",
      registration_endpoint: "https://prop-lane.test/api/mcp/oauth/register",
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("permits only HTTPS and loopback OAuth redirects", () => {
    expect(isSafeOAuthRedirectUri("https://claude.example/callback")).toBe(true);
    expect(isSafeOAuthRedirectUri("http://localhost:3000/callback")).toBe(true);
    expect(isSafeOAuthRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isSafeOAuthRedirectUri("https://claude.example/callback#token")).toBe(false);
  });

  it("binds browser consent to the signed-in manager and request details", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-approval-secret");
    const token = signMcpApproval({ userId: "manager_1", clientId: "client_1", redirectUri: "https://client.test/callback", codeChallenge: "a".repeat(43), scope: "mcp:tools", state: "state" });
    expect(token).toBeTruthy();
    expect(verifyMcpApproval(token!)).toMatchObject({ userId: "manager_1", clientId: "client_1" });
    expect(verifyMcpApproval(`${token}tampered`)).toBeNull();
    vi.unstubAllEnvs();
  });
});
