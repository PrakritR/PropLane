/**
 * The one dispatcher behind every external transport. `/api/mcp` (JSON-RPC) and
 * `/api/v1/tools` (plain HTTP) both call ONLY this module, so the two can never
 * disagree about what a key may see or do.
 *
 * Reads run straight through `runReadTool`. Writes never execute here: they
 * build their existing preview, park an `agent_pending_actions` row, and hand
 * back an action id. `confirm_action` then goes through
 * `runConfirmedPendingActionForPortal` — the same gate the in-product
 * assistant, the dashboard AI-draft chips, and the tour proposals use. There is
 * exactly one confirm path in this codebase and this is not a second one.
 */
import "server-only";

import type { AgentContext } from "@/lib/tools/context";
import { agentRegistry } from "@/lib/tools";
import { previewWriteTool, runReadTool, toAnthropicTools } from "@/lib/tools/registry";
import { createPendingAction } from "@/lib/tools/pending-actions";
import { peekPendingActionPortal } from "@/lib/tools/pending-actions";
import { runConfirmedPendingActionForPortal } from "@/lib/tools/confirm-gate.server";
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

const CONFIRM_ACTION_TOOL: McpToolSchema = {
  name: CONFIRM_ACTION_TOOL_NAME,
  description:
    "Execute a write action that was previously proposed by calling one of the action tools. " +
    "Pass the actionId returned by that proposal. This is the step that actually changes data, " +
    "so only call it once the person you are acting for has seen the preview and approved it. " +
    "A proposal expires 15 minutes after it is created and can only be confirmed once.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["actionId"],
    properties: {
      actionId: {
        type: "string",
        description: "The actionId returned by the proposal you are confirming.",
      },
    },
  },
};

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
  const tools = toAnthropicTools(agentRegistry, { readOnly: !write })
    .filter((tool) => toolIsAllowed(tool.name, allowedTools, scopes))
    .map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
    }));
  return write ? [...tools, CONFIRM_ACTION_TOOL] : tools;
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
    if (!hasWriteScope(allowedTools, scopes)) return { ok: false, error: WRITE_SCOPE_REFUSAL };
    const actionId = (input as { actionId?: unknown } | null)?.actionId;
    if (typeof actionId !== "string" || !actionId.trim()) {
      return { ok: false, error: "confirm_action requires the actionId returned by the proposal." };
    }
    const peeked = await peekPendingActionPortal(ctx, actionId.trim());
    if (peeked.state === "found" && !toolIsAllowed(peeked.toolName, allowedTools, scopes)) {
      return { ok: false, error: "This API key is not permitted to confirm that action." };
    }
    const confirmed = await runConfirmedPendingActionForPortal(ctx, agentRegistry, "manager", actionId.trim(), {
      landlordId: ctx.landlordId,
      role: "manager",
      surface: "mcp",
    });
    if (!confirmed.ok) return { ok: false, error: confirmed.error };
    return {
      ok: true,
      data: {
        status: "executed",
        tool: confirmed.toolName,
        reply: confirmed.reply,
        ...(confirmed.checkoutUrl ? { checkoutUrl: confirmed.checkoutUrl } : {}),
      },
    };
  }

  const tool = agentRegistry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (!toolIsAllowed(name, allowedTools, scopes)) {
    return { ok: false, error: "This API key is not permitted to use that tool." };
  }

  if (tool.kind === "read") {
    // No allowWrite here: MANAGER_INLINE_WRITE_TOOLS is deliberately NOT
    // honoured over MCP. One rule — every write is proposed, then confirmed.
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
        "Nothing has been written yet. Show this preview to the person you are acting for, " +
        `then call ${CONFIRM_ACTION_TOOL_NAME} with this actionId to execute it.`,
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
  const analyticsTool = name === CONFIRM_ACTION_TOOL_NAME || agentRegistry.has(name) ? name : "unknown";
  track("mcp_tool_called", ctx.userId, { tool: analyticsTool, ok: result.ok, transport });
  return result;
}
