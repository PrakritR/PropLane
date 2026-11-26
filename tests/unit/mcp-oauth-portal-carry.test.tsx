import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/portal/portal-icon-action", () => ({
  PortalIconAction: ({ label }: { label: string }) => <button aria-label={label} />,
}));

import { ConnectClaudeBlock } from "@/components/mcp/connect-claude-block";
import { createMcpAuthorizationCode, exchangeMcpAuthorizationCode, normalizeMcpPortal, refreshMcpAccessToken } from "@/lib/mcp/oauth.server";
import { MCP_PUBLIC_URL } from "@/lib/mcp/public-url";

/** A tiny in-memory stand-in for the three service-role tables this flow touches. */
function fakeDb() {
  const tables: Record<string, Record<string, unknown>[]> = { mcp_oauth_authorization_codes: [], mcp_oauth_tokens: [] };
  const from = (name: string) => {
    const rows = tables[name]!;
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    let patch: Record<string, unknown> | null = null;
    const api = {
      insert(row: Record<string, unknown>) { rows.push({ id: `id${rows.length}`, ...row }); return api; },
      select() { return api; },
      update(p: Record<string, unknown>) { patch = p; return api; },
      eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return api; },
      is(k: string, v: unknown) { filters.push((r) => (r[k] ?? null) === v); return api; },
      async maybeSingle() { const hit = rows.find((r) => filters.every((f) => f(r))); if (hit && patch) Object.assign(hit, patch); return { data: hit ?? null }; },
      async single() { return { data: rows[rows.length - 1] ?? null, error: null }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ error: null, data: null }).then(resolve); },
    };
    return api;
  };
  return { db: { from } as never, tables };
}

const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("the connection's portal rides the code, the token and every refresh", () => {
  it("normalizes anything unknown to manager", () => {
    expect(normalizeMcpPortal("resident")).toBe("resident");
    expect(normalizeMcpPortal("vendor")).toBe("manager");
    expect(normalizeMcpPortal(undefined)).toBe("manager");
  });

  it("a resident code (no workspace) exchanges to a resident token and refreshes as one", async () => {
    const { db, tables } = fakeDb();
    const code = await createMcpAuthorizationCode(db, { userId: "u1", clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: challenge, scopes: ["mcp:tools"], workspaceId: null, portal: "resident" });
    expect(tables.mcp_oauth_authorization_codes[0]).toMatchObject({ portal: "resident", workspace_id: null });
    const issued = await exchangeMcpAuthorizationCode(db, { code: code!, clientId: "c1", redirectUri: "https://claude.ai/cb", codeVerifier: verifier });
    expect(issued).not.toBeNull();
    expect(tables.mcp_oauth_tokens[0]).toMatchObject({ portal: "resident", workspace_id: null });
    const refreshed = await refreshMcpAccessToken(db, { refreshToken: issued!.refreshToken, clientId: "c1" });
    expect(refreshed).not.toBeNull();
    expect(tables.mcp_oauth_tokens[1]).toMatchObject({ portal: "resident", workspace_id: null });
  });

  it("a manager code with no workspace still refuses", async () => {
    const { db } = fakeDb();
    const code = await createMcpAuthorizationCode(db, { userId: "u1", clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: challenge, scopes: ["mcp:tools"], workspaceId: null });
    expect(await exchangeMcpAuthorizationCode(db, { code: code!, clientId: "c1", redirectUri: "https://claude.ai/cb", codeVerifier: verifier })).toBeNull();
  });

  it("a manager connection keeps its workspace and stays manager through a refresh", async () => {
    const { db, tables } = fakeDb();
    const code = await createMcpAuthorizationCode(db, { userId: "u1", clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: challenge, scopes: ["mcp:tools"], workspaceId: "svc_1" });
    const issued = await exchangeMcpAuthorizationCode(db, { code: code!, clientId: "c1", redirectUri: "https://claude.ai/cb", codeVerifier: verifier });
    await refreshMcpAccessToken(db, { refreshToken: issued!.refreshToken, clientId: "c1" });
    expect(tables.mcp_oauth_tokens[1]).toMatchObject({ portal: "manager", workspace_id: "svc_1" });
  });
});

describe("Settings: Connect Claude", () => {
  it("shows the MCP URL, an icon Copy action and one instruction list, with no subtext", () => {
    expect(MCP_PUBLIC_URL).toBe("https://proplane.ai/api/mcp");
    const html = renderToStaticMarkup(<ConnectClaudeBlock />);
    expect(html).toContain("Connect Claude");
    expect(html).toContain("https://proplane.ai/api/mcp");
    expect(html).toContain('aria-label="Copy MCP URL"');
    expect(html).toContain("Add custom connector");
    expect(html).toContain("As resident");
    expect((html.match(/<ol/g) ?? []).length).toBe(1);
    expect(html).not.toContain("Claude Code");
    expect(renderToStaticMarkup(<ConnectClaudeBlock includeClaudeCode />)).toContain("claude mcp add --transport http proplane https://proplane.ai/api/mcp");
  });
});
