import { describe, expect, it } from "vitest";

import { callTool, CONFIRM_ACTION_TOOL_NAME, listTools } from "@/lib/mcp/gateway";
import { API_KEY_PRODUCT_AREAS, API_KEY_TOOL_NAMES, EXTERNAL_EXCLUDED_TOOL_NAMES } from "@/lib/mcp/capabilities";
import { agentRegistry } from "@/lib/tools";
import { makeManagerRowsCtx } from "./tools/fake-agent-ctx";

describe("MCP tool scope", () => {
  it("assigns every manager tool to an external area or an explicit exclusion", () => {
    expect([...agentRegistry.keys()].filter((name) => !API_KEY_TOOL_NAMES.has(name))).toEqual([...EXTERNAL_EXCLUDED_TOOL_NAMES]);
    for (const name of EXTERNAL_EXCLUDED_TOOL_NAMES) expect(agentRegistry.has(name)).toBe(true);
  });

  it("refuses metered research for legacy broad and explicit external credentials", async () => {
    const name = "get_property_location_research";
    const ctx = makeManagerRowsCtx({});
    expect(listTools([], ["read"]).some((tool) => tool.name === name)).toBe(false);
    expect(listTools([name], ["read"]).some((tool) => tool.name === name)).toBe(false);
    expect(await callTool(ctx, [], ["read"], name, { propertyId: "p1", topic: "schools" }, "mcp", "legacy"))
      .toEqual({ ok: false, error: "This API key is not permitted to use that tool." });
    expect(await callTool(ctx, [name], ["read"], name, { propertyId: "p1", topic: "schools" }, "rest", "explicit"))
      .toEqual({ ok: false, error: "This API key is not permitted to use that tool." });
  });

  it("hides writes from a read key and never publishes a bearer-confirm tool", () => {
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
    expect(writeTools).not.toContainEqual(expect.objectContaining({ name: CONFIRM_ACTION_TOOL_NAME }));
    expect(writeTools.length).toBeGreaterThan(readTools.length);
  });

  it("enforces scope at dispatch even when a caller guesses a write tool name", async () => {
    const writeName = API_KEY_PRODUCT_AREAS.flatMap((area) => area.writeTools)[0]!;
    const protectedResult = await callTool(makeManagerRowsCtx({}), ["list_charges"], [], writeName, {}, "mcp", "key_1");
    expect(protectedResult).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("not permitted") }));
  });

  it("never lets an external bearer credential confirm a staged action", async () => {
    const writeAllowed = API_KEY_PRODUCT_AREAS.flatMap((area) => [...area.readTools, ...area.writeTools]);
    const result = await callTool(makeManagerRowsCtx({}), writeAllowed, [], CONFIRM_ACTION_TOOL_NAME, { actionId: "proposal_1" }, "mcp", "key_1");
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("cannot confirm") }));
  });
});
