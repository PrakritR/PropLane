import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));

import McpConnectedPage from "@/app/mcp/connected/page";
import { McpAutoContinue } from "@/components/mcp/mcp-auto-continue";
import { signMcpConnected } from "@/lib/mcp/oauth.server";

const DESTINATION = "https://claude.ai/api/mcp/auth_callback?code=c&state=s";

/** Depth-first search of a server-rendered element tree for a component type. */
function find(node: ReactNode, type: unknown): ReactElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) return el;
  return find(el.props?.children, type);
}

async function render(t: string | undefined) {
  return McpConnectedPage({ searchParams: Promise.resolve(t === undefined ? {} : { token: t }) });
}

describe("/mcp/connected", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-secret");
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("continues to the verified destination", async () => {
    const token = signMcpConnected({ destination: DESTINATION, clientName: "Claude", workspaceName: "Main Street", userId: "u1" })!;
    const auto = find(await render(token), McpAutoContinue);
    expect(auto?.props).toMatchObject({ destination: DESTINATION });
  });

  it.each([
    ["missing", undefined],
    ["tampered", "abc.def"],
  ])("a %s token shows an error and never redirects", async (_label, t) => {
    expect(find(await render(t), McpAutoContinue)).toBeNull();
  });

  it("a valid token opened by a different signed-in user is inert", async () => {
    const token = signMcpConnected({ destination: DESTINATION, clientName: "Claude", workspaceName: "W", userId: "u1" })!;
    getUser.mockResolvedValue({ data: { user: { id: "u2" } } });
    expect(find(await render(token), McpAutoContinue)).toBeNull();
    getUser.mockResolvedValue({ data: { user: null } });
    expect(find(await render(token), McpAutoContinue)).toBeNull();
  });
});
