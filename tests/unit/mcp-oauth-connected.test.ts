import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tools/context", () => ({ resolveAgentContext }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcp/oauth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/oauth.server")>()),
  getMcpOAuthClient: vi.fn(async () => ({
    clientId: "c1",
    clientName: "Claude",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  })),
  createMcpAuthorizationCode: vi.fn(async () => "pl_mcp_code_test"),
}));

import { POST as approve } from "@/app/api/mcp/oauth/approve/route";
import { signMcpApproval, signMcpConnected, verifyMcpApproval, verifyMcpConnected } from "@/lib/mcp/oauth.server";

const DESTINATION = "https://claude.ai/api/mcp/auth_callback?code=pl_mcp_code_test&state=s1";
const base = { destination: DESTINATION, clientName: "Claude", workspaceName: "Main Street", userId: "u1" };

describe("MCP connected token", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-secret");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("round-trips the payload", () => {
    const token = signMcpConnected(base)!;
    expect(verifyMcpConnected(token)).toMatchObject(base);
  });

  it("rejects a tampered payload or signature", () => {
    const token = signMcpConnected(base)!;
    const [encoded, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...base, destination: "https://evil.example/cb", expiresAt: Date.now() + 60_000 })).toString("base64url");
    expect(verifyMcpConnected(`${forged}.${signature}`)).toBeNull();
    expect(verifyMcpConnected(`${encoded}.${signature!.slice(0, -2)}AA`)).toBeNull();
    expect(verifyMcpConnected(`${encoded}.${signature}.extra`)).toBeNull();
    expect(verifyMcpConnected("")).toBeNull();
    expect(verifyMcpConnected("garbage")).toBeNull();
  });

  it("expires after two minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    const token = signMcpConnected(base)!;
    vi.setSystemTime(new Date("2026-10-09T12:01:59Z"));
    expect(verifyMcpConnected(token)).not.toBeNull();
    vi.setSystemTime(new Date("2026-10-09T12:02:01Z"));
    expect(verifyMcpConnected(token)).toBeNull();
  });

  it("refuses a destination that is not a safe OAuth redirect and signs nothing without a secret", () => {
    expect(signMcpConnected({ ...base, destination: "javascript:alert(1)" })).toBeNull();
    expect(signMcpConnected({ ...base, destination: "http://evil.example/cb" })).toBeNull();
    expect(signMcpConnected({ ...base, destination: "http://localhost:3000/cb?code=x" })).not.toBeNull();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(signMcpConnected(base)).toBeNull();
  });

  it("is not interchangeable with the consent approval token", () => {
    const approval = signMcpApproval({ userId: "u1", clientId: "c1", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "a".repeat(43), scope: "mcp:tools", state: "s1" })!;
    expect(verifyMcpConnected(approval)).toBeNull();
    expect(verifyMcpApproval(signMcpConnected(base)!)).toBeNull();
  });
});

describe("approve route -> connected screen (real signing)", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-secret");
    resolveAgentContext.mockResolvedValue({ userId: "u1", db: {}, workspace: { id: "w1", name: "Main Street" } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("303s to /mcp/connected with a token that carries only the validated callback", async () => {
    const approval = signMcpApproval({ userId: "u1", clientId: "c1", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "a".repeat(43), scope: "mcp:tools", state: "s1" })!;
    const body = new FormData();
    body.set("approval", approval);
    const res = await approve(new Request("https://prop-lane.test/api/mcp/oauth/approve", { method: "POST", body }));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "", "https://prop-lane.test");
    expect(location.origin + location.pathname).toBe("https://prop-lane.test/mcp/connected");
    const payload = verifyMcpConnected(location.searchParams.get("t") ?? "");
    expect(payload).toMatchObject({ clientName: "Claude", workspaceName: "Main Street", userId: "u1" });
    const destination = new URL(payload!.destination);
    expect(destination.origin + destination.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(destination.searchParams.get("code")).toBe("pl_mcp_code_test");
    expect(destination.searchParams.get("state")).toBe("s1");
  });

  it("an approval for a different user is still refused", async () => {
    const approval = signMcpApproval({ userId: "someone-else", clientId: "c1", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "a".repeat(43), scope: "mcp:tools", state: "s1" })!;
    const body = new FormData();
    body.set("approval", approval);
    const res = await approve(new Request("https://prop-lane.test/api/mcp/oauth/approve", { method: "POST", body }));
    expect(res.status).toBe(400);
  });
});
