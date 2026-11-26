import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { createPendingAction } = vi.hoisted(() => ({ createPendingAction: vi.fn() }));
vi.mock("@/lib/tools/pending-actions", () => ({ createPendingAction }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/observability/langfuse", () => ({
  traceExternalToolCall: async (_a: unknown, _i: unknown, run: () => Promise<unknown>) => run(),
}));

import { callTool, listTools } from "@/lib/mcp/gateway";
import { callResidentTool, listResidentTools } from "@/lib/mcp/resident-gateway";
import { RESIDENT_EXTERNAL_EXCLUDED_TOOL_NAMES } from "@/lib/mcp/capabilities";
import { agentRegistry } from "@/lib/tools";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

function residentCtx(over: Partial<ResidentAgentContext> = {}): ResidentAgentContext {
  return {
    kind: "resident",
    userId: "res_1",
    email: "res@example.test",
    managerIds: ["mgr_1"],
    channel: "portal",
    phase: "approved",
    managerTier: null,
    moveInDetailsLocked: false,
    landlordId: "res_1",
    db: {} as ResidentAgentContext["db"],
    ...over,
  } as ResidentAgentContext;
}

describe("a resident connection reaches only resident tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists tools drawn only from the resident registry", () => {
    const names = listResidentTools(residentCtx()).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    // `find_homes_on_proplane` is the portal channel's one extra (the public catalog read), added by
    // `buildResidentRegistry` itself, exactly as the resident portal's assistant has it.
    for (const name of names) expect(residentAgentRegistry.has(name) || name === "find_homes_on_proplane", name).toBe(true);
    const managerOnly = [...agentRegistry.keys()].filter((n) => !residentAgentRegistry.has(n));
    expect(managerOnly.length).toBeGreaterThan(0);
    for (const name of managerOnly) expect(names, name).not.toContain(name);
  });

  it("a resident token cannot call a manager-only tool, and nothing is staged", async () => {
    const managerOnly = [...agentRegistry.keys()].filter((n) => !residentAgentRegistry.has(n));
    for (const name of managerOnly.slice(0, 12)) {
      const result = await callResidentTool(residentCtx(), name, {}, "oauth:t1");
      expect(result, name).toEqual({ ok: false, error: `Unknown tool: ${name}` });
    }
    expect(createPendingAction).not.toHaveBeenCalled();
  });

  it("a manager connection cannot call a resident-only tool or list one", async () => {
    const residentOnly = [...residentAgentRegistry.keys()].filter((n) => !agentRegistry.has(n));
    expect(residentOnly.length).toBeGreaterThan(0);
    const listed = listTools([], ["read", "write"]).map((t) => t.name);
    for (const name of residentOnly) expect(listed, name).not.toContain(name);
    const ctx = { landlordId: "m1", userId: "m1", email: "", roles: ["manager"], isAdmin: false, db: {} } as never;
    for (const name of residentOnly.slice(0, 12)) {
      const result = await callTool(ctx, [], ["read", "write"], name, {}, "mcp", "oauth:m1");
      expect(result.ok, name).toBe(false);
    }
  });

  // The secrets a resident reads in their own portal do not travel to an external client: the manager half already
  // withholds `get_room_door_code` and its knowledge pair for this reason (`EXTERNAL_EXCLUDED_TOOL_NAMES`), and these
  // two carry the front-door / room codes and the Wi-Fi password once the check-in reveal opens.
  it("neither lists nor serves the tools that carry the door codes and the Wi-Fi password", async () => {
    const names = listResidentTools(residentCtx()).map((t) => t.name);
    for (const excluded of RESIDENT_EXTERNAL_EXCLUDED_TOOL_NAMES) {
      expect(residentAgentRegistry.has(excluded), excluded).toBe(true);
      expect(names, excluded).not.toContain(excluded);
      expect(await callResidentTool(residentCtx(), excluded, {}, "oauth:t1")).toEqual({
        ok: false,
        error: `Unknown tool: ${excluded}`,
      });
    }
    expect(createPendingAction).not.toHaveBeenCalled();
    // The rest of the portal's toolset still travels.
    expect(names).toContain("get_my_balance");
  });

  it("a resident cannot confirm its own proposal over MCP", async () => {
    const result = await callResidentTool(residentCtx(), "confirm_action", { actionId: "a1" });
    expect(result.ok).toBe(false);
    expect(createPendingAction).not.toHaveBeenCalled();
  });

  it("the application phase gets the portal's reduced toolset", () => {
    const approved = listResidentTools(residentCtx({ phase: "approved" })).length;
    const application = listResidentTools(residentCtx({ phase: "application" })).length;
    expect(application).toBeLessThan(approved);
  });
});

describe("a resident write only proposes, in the resident portal", () => {
  it("parks a pending action with portal resident and changes nothing", async () => {
    vi.resetModules();
    vi.doMock("@/lib/tools/resident-index", async () => {
      const { buildRegistry, defineWriteTool } = await import("@/lib/tools/registry");
      const handler = vi.fn();
      const tool = defineWriteTool({
        name: "fake_resident_write",
        description: "A fake resident write.",
        inputSchema: z.object({ note: z.string() }),
        preview: async (_ctx: unknown, input: { note: string }) => ({ title: "Add note", summary: input.note, lines: [] }),
        handler,
      } as never);
      const registry = buildRegistry([tool as never]);
      return { buildResidentRegistry: () => registry, residentAgentRegistry: registry, __handler: handler };
    });
    createPendingAction.mockResolvedValue("act_1");
    const { callResidentTool: call } = await import("@/lib/mcp/resident-gateway");
    const index = (await import("@/lib/tools/resident-index")) as unknown as { __handler: ReturnType<typeof vi.fn> };
    const result = await call(residentCtx(), "fake_resident_write", { note: "hi" }, "oauth:t1");
    expect(result).toMatchObject({ ok: true, data: { status: "awaiting_confirmation", actionId: "act_1" } });
    expect(createPendingAction).toHaveBeenCalledWith(expect.anything(), "fake_resident_write", { note: "hi" }, expect.anything(), { portal: "resident" });
    expect(index.__handler).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/tools/resident-index");
  });
});
