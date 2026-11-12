import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/managed-read-only.server", () => ({ isManagedReadOnly: async () => false, managedReadOnlyWorkspaceIds: async () => [] }));
vi.mock("@/lib/manager-communication-access.server", () => ({ MANAGER_COMMUNICATION_UNREADABLE_MESSAGE: "x", assertManagerCommunicationAllowedForWorkspace: async () => ({ allowed: true }) }));

import { buildAllModulesGrant } from "@/lib/co-manager-permissions";
import { buildManagerSmsRegistry } from "@/lib/tools";
import { DELEGATED_LISTING_EDIT_TOOLS, scopeManagerTool } from "@/lib/tools/manager-co-manager-tool-scope";

const access = (perm: "edit" | "read", props = ["h1"]) => ({
  mode: "delegated" as const, workNumberOwnerId: "own", actorUserId: "staff", dataOwnerIds: ["own"], assignedPropertyIds: props,
  permissionsByOwner: { own: Object.fromEntries(props.map((p) => [p, buildAllModulesGrant(perm)])) },
});
const ctxOf = (a: ReturnType<typeof access>) => ({ landlordId: "own", userId: "staff", db: {}, managerSmsAccess: a, workspace: { id: "ws", name: "w", isDefault: false, narrowing: true, propertyIds: ["h1"] } }) as never;

function probe() {
  const calls: string[] = [];
  const tool = scopeManagerTool({
    name: "update_room_rent", kind: "write", description: "", inputSchema: {} as never, destructive: false,
    preview: async () => { calls.push("preview"); return {} as never; }, handler: async () => { calls.push("handler"); return {} as never; },
  } as never);
  return { tool: tool as unknown as { preview: (c: never, i: unknown) => Promise<unknown>; handler: (c: never, i: unknown) => Promise<unknown> }, calls };
}

describe("delegated seats and listing-edit tools", () => {
  it("the three listing edits are in a delegated registry, other portal-only writes are not", () => {
    const reg = buildManagerSmsRegistry(access("edit"));
    for (const name of DELEGATED_LISTING_EDIT_TOOLS) expect(reg.has(name)).toBe(true);
    expect(reg.has("create_listing_draft_by_text")).toBe(false);
  });
  it("a seat with Properties at edit on that house may preview and run it", async () => {
    const { tool, calls } = probe();
    await tool.preview(ctxOf(access("edit")), { propertyId: "h1" });
    await tool.handler(ctxOf(access("edit")), { propertyId: "h1" });
    expect(calls).toEqual(["preview", "handler"]);
  });
  it("read-only grant, another house, or no propertyId is refused in BOTH phases", async () => {
    for (const [a, input] of [[access("read"), { propertyId: "h1" }], [access("edit"), { propertyId: "h2" }], [access("edit"), {}]] as const) {
      const { tool, calls } = probe();
      await expect(tool.preview(ctxOf(a), input)).rejects.toThrow(/not available/);
      await expect(tool.handler(ctxOf(a), input)).rejects.toThrow(/not available/);
      expect(calls).toEqual([]);
    }
  });
});
