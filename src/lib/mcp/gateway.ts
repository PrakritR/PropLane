/**
 * The one dispatcher behind every external transport. `/api/mcp` (JSON-RPC) and
 * `/api/v1/tools` (plain HTTP) both call ONLY this module, so the two can never
 * disagree about what a key may see or do.
 *
 * Reads run straight through `runReadTool`. Writes never execute here: they
 * build their existing preview, park an `agent_pending_actions` row, and hand
 * back an action id. Only the signed-in manager can confirm that row in
 * PropLane's existing AI-draft UI, through `runConfirmedPendingActionForPortal`.
 * A bearer credential may never self-confirm its own proposal.
 */
import "server-only";

import type { AgentContext } from "@/lib/tools/context";
import { agentRegistry } from "@/lib/tools";
import { previewWriteTool, runReadTool, toAnthropicTools } from "@/lib/tools/registry";
import { createPendingAction } from "@/lib/tools/pending-actions";
import { track } from "@/lib/analytics/posthog";
import { traceExternalToolCall } from "@/lib/observability/langfuse";
import type { ApiKeyScope } from "./api-keys.server";

/** MCP names the field `inputSchema`; the payload is the same JSON Schema. */
export type McpToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const CONFIRM_ACTION_TOOL_NAME = "confirm_action";

/** Matches the pending-action row's 15-minute default expiry. */
const PENDING_ACTION_TTL_SECONDS = 900;

function isLegacyBroadKey(allowedTools: readonly string[]): boolean {
  return allowedTools.length === 0;
}

/** Old rows created before the allowlist migration retain their broad scope. */
function toolIsAllowed(name: string, allowedTools: readonly string[], scopes: readonly ApiKeyScope[]): boolean {
  if (!isLegacyBroadKey(allowedTools)) return allowedTools.includes(name);
  const tool = agentRegistry.get(name);
  return tool?.kind === "read" || (tool?.kind === "write" && scopes.includes("write"));
}

export function hasWriteScope(allowedTools: readonly string[], scopes: readonly ApiKeyScope[] = []): boolean {
  if (isLegacyBroadKey(allowedTools)) return scopes.includes("write");
  return allowedTools.some((name) => agentRegistry.get(name)?.kind === "write");
}

/**
 * The tool catalog for a key. Scope is enforced here AND again in `callTool` —
 * a client that guesses a write tool's name must still be refused, so the
 * listing is a convenience, never the control.
 *
 * ponytail: a write-scoped key lists ~96 tools (~20k tokens of definitions),
 * which is heavy for a small model's context. Upgrade path when someone hits
 * it: a per-key tool allowlist column filtered right here. Not built now —
 * every caller so far wants the full surface.
 */
export function listTools(allowedTools: readonly string[], scopes: readonly ApiKeyScope[] = []): McpToolSchema[] {
  const write = hasWriteScope(allowedTools, scopes);
  return toAnthropicTools(agentRegistry, { readOnly: !write })
    .filter((tool) => toolIsAllowed(tool.name, allowedTools, scopes))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    }));
}

export type CallToolResult = { ok: true; data: unknown } | { ok: false; error: string };

const WRITE_SCOPE_REFUSAL =
  "This API key is read-only. Create a key with the write scope in PropLane Settings → API & MCP to propose actions.";

async function dispatch(
  ctx: AgentContext,
  allowedTools: readonly string[],
  scopes: readonly ApiKeyScope[],
  name: string,
  input: unknown,
): Promise<CallToolResult> {
  if (name === CONFIRM_ACTION_TOOL_NAME) {
    return {
      ok: false,
      error: "External credentials cannot confirm actions. A signed-in manager must approve this proposal in PropLane’s AI drafts.",
    };
  }

  const tool = agentRegistry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (!toolIsAllowed(name, allowedTools, scopes)) {
    return { ok: false, error: "This API key is not permitted to use that tool." };
  }

  if (tool.kind === "read") {
    // No allowWrite here: MANAGER_INLINE_WRITE_TOOLS is deliberately NOT
    // honoured over MCP. One rule — every write is proposed, then manager-approved.
    return runReadTool(agentRegistry, ctx, name, input);
  }

  const previewed = await previewWriteTool(agentRegistry, ctx, name, input);
  if (!previewed.ok) return { ok: false, error: previewed.error };

  const actionId = await createPendingAction(ctx, name, previewed.input, previewed.preview, {
    portal: "manager",
  });
  if (!actionId) {
    return { ok: false, error: "Could not stage this action. Please try again." };
  }

  return {
    ok: true,
    data: {
      status: "awaiting_confirmation",
      actionId,
      destructive: previewed.destructive,
      expiresInSeconds: PENDING_ACTION_TTL_SECONDS,
      preview: previewed.preview,
      message:
        "Nothing has been written yet. A signed-in manager must review and approve this preview in PropLane’s AI drafts.",
    },
  };
}

export async function callTool(
  ctx: AgentContext,
  allowedTools: readonly string[],
  scopes: readonly ApiKeyScope[],
  name: string,
  input: unknown,
  transport: "mcp" | "rest" = "mcp",
  keyId = "unknown",
): Promise<CallToolResult> {
  const result = await traceExternalToolCall(
    { userId: ctx.userId, sessionId: `mcp:${keyId}`, metadata: { landlordId: ctx.landlordId, role: "manager" } },
    { toolName: name, input, transport, keyId },
    () => dispatch(ctx, allowedTools, scopes, name, input),
  );
  // Never put arbitrary caller text in product analytics. Registry names and
  // the synthetic confirmation name are fixed enum-like values; a guessed
  // unknown name is deliberately collapsed before PostHog sees it.
  const analyticsTool = agentRegistry.has(name) ? name : "unknown";
  track("mcp_tool_called", ctx.userId, { tool: analyticsTool, ok: result.ok, transport });
  return result;
}
