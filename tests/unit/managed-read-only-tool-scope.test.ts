import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const locked = vi.hoisted(() => ({ ids: [] as string[], fail: false }));
vi.mock("@/lib/auth/managed-read-only.server", () => ({
  isManagedReadOnly: async (_db: unknown, _user: string, ws: string) => {
    if (locked.fail) return true;
    return locked.ids.includes(ws);
  },
  managedReadOnlyWorkspaceIds: async () => {
    if (locked.fail) throw new Error("boom");
    return locked.ids;
  },
}));

import { scopeManagerTool } from "@/lib/tools/manager-co-manager-tool-scope";
import { MANAGED_READ_ONLY_TOOL_MESSAGE } from "@/lib/auth/managed-read-only-policy";
import { UNRESOLVED_AGENT_WORKSPACE_SCOPE } from "@/lib/agent/manager-workspace-scope";
import type { AgentContext } from "@/lib/tools/context";

const ws = (id: string) => ({ id, name: "W", isDefault: true, narrowing: false, propertyIds: [] });
const ctx = (workspace?: AgentContext["workspace"]) => ({ db: {}, userId: "client", landlordId: "client", workspace }) as unknown as AgentContext;

function tool(kind: "read" | "write") {
  const handler = vi.fn(async () => "ran");
  const preview = vi.fn(async () => ({ summary: "p" }));
  const base = kind === "write" ? { name: "update_thing", kind, preview, handler } : { name: "list_things", kind, handler };
  return { scoped: scopeManagerTool(base as never) as never as { handler: (c: AgentContext, i: unknown) => Promise<unknown>; preview?: (c: AgentContext, i: unknown) => Promise<unknown> }, handler, preview };
}

beforeEach(() => {
  locked.ids = ["ws-locked"];
  locked.fail = false;
});

describe("scopeManagerTool on a view-only managed workspace", () => {
  it("refuses a write tool in preview AND handler with the plain message", async () => {
    const { scoped, handler, preview } = tool("write");
    await expect(scoped.preview!(ctx(ws("ws-locked")), {})).rejects.toThrow(MANAGED_READ_ONLY_TOOL_MESSAGE);
    await expect(scoped.handler(ctx(ws("ws-locked")), {})).rejects.toThrow(MANAGED_READ_ONLY_TOOL_MESSAGE);
    expect(preview).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("allows a read tool", async () => {
    const { scoped } = tool("read");
    await expect(scoped.handler(ctx(ws("ws-locked")), {})).resolves.toBe("ran");
  });
  it("allows a write in an unlocked workspace and when no workspace scope applies", async () => {
    const { scoped } = tool("write");
    await expect(scoped.handler(ctx(ws("ws-open")), {})).resolves.toBe("ran");
    await expect(scoped.handler(ctx(undefined), {})).resolves.toBe("ran");
  });
  it("fails closed: a failed lookup, or an unresolved scope for a user with a locked workspace, refuses", async () => {
    const { scoped } = tool("write");
    locked.fail = true;
    await expect(scoped.handler(ctx(ws("ws-open")), {})).rejects.toThrow(MANAGED_READ_ONLY_TOOL_MESSAGE);
    locked.fail = false;
    await expect(scoped.handler(ctx(UNRESOLVED_AGENT_WORKSPACE_SCOPE), {})).rejects.toThrow(MANAGED_READ_ONLY_TOOL_MESSAGE);
    locked.ids = [];
    await expect(scoped.handler(ctx(UNRESOLVED_AGENT_WORKSPACE_SCOPE), {})).resolves.toBe("ran");
  });
});
