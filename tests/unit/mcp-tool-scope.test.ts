import { describe, expect, it } from "vitest";

import { callTool, CONFIRM_ACTION_TOOL_NAME, listTools } from "@/lib/mcp/gateway";
import { API_KEY_PRODUCT_AREAS } from "@/lib/mcp/capabilities";
import { API_KEY_TOOL_NAMES } from "@/lib/mcp/capabilities";
import { agentRegistry } from "@/lib/tools";
import { makeManagerRowsCtx } from "./tools/fake-agent-ctx";

describe("MCP tool scope", () => {
  it("assigns every manager tool to an externally grantable product area", () => {
    expect([...agentRegistry.keys()].filter((name) => !API_KEY_TOOL_NAMES.has(name))).toEqual([]);
  });

  it("hides writes from a read key and publishes object JSON Schema", () => {
    const readAllowed = API_KEY_PRODUCT_AREAS.flatMap((area) => area.readTools);
    const readTools = listTools(readAllowed);
    expect(readTools).not.toContainEqual(expect.objectContaining({ name: CONFIRM_ACTION_TOOL_NAME }));
    expect(readTools.length).toBeGreaterThan(0);
    for (const tool of readTools) {
      expect(tool.description.trim(), tool.name).not.toBe("");
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }

    const writeAllowed = API_KEY_PRODUCT_AREAS.flatMap((area) => [...area.readTools, ...area.writeTools]);
    const writeTools = listTools(writeAllowed);
    expect(writeTools).toContainEqual(expect.objectContaining({ name: CONFIRM_ACTION_TOOL_NAME }));
    expect(writeTools.length).toBeGreaterThan(readTools.length);
  });

  it("enforces scope at dispatch even when a caller guesses a write tool name", async () => {
    const writeName = API_KEY_PRODUCT_AREAS.flatMap((area) => area.writeTools)[0]!;
    const protectedResult = await callTool(makeManagerRowsCtx({}), ["list_charges"], [], writeName, {}, "mcp", "key_1");
    expect(protectedResult).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("not permitted") }));
  });
});
