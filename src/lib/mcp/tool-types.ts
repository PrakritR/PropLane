/** Shapes shared by the manager gateway and the resident gateway. No registry is imported here, on purpose. */

/** MCP names the field `inputSchema`; the payload is the same JSON Schema. */
export type McpToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const CONFIRM_ACTION_TOOL_NAME = "confirm_action";

export type CallToolResult = { ok: true; data: unknown } | { ok: false; error: string };
