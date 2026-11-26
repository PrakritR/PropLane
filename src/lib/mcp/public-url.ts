/** The one MCP address people paste into Claude. Never derived from the browser's origin: a staging or preview address is not a connector. */
export const MCP_PUBLIC_URL = "https://proplane.ai/api/mcp";

/** Claude Code's one-liner for the same server. */
export const MCP_CLAUDE_CODE_COMMAND = `claude mcp add --transport http proplane ${MCP_PUBLIC_URL}`;

/** The connect steps, shared by the manager and resident settings so the two never drift. */
export const MCP_CONNECT_STEPS = [
  "In Claude, open Settings, then Connectors.",
  "Choose Add custom connector and paste the URL above.",
  "Sign in to PropLane when asked.",
  "Pick a workspace, or As resident, then Allow.",
] as const;
