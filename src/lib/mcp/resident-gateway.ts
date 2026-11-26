/**
 * The resident half of the MCP server. `/api/mcp` calls THIS module for a connection whose consent chose
 * "As resident", and `gateway.ts` (the manager half) for every other one. The two never share a registry:
 * this file imports only the resident registry, `gateway.ts` imports only the manager one, and
 * `tests/unit/mcp-resident-connection.test.ts` fails if either imports the other's.
 *
 * Tools come from the resident portal's own registry (`buildResidentRegistry`, which is `residentAgentRegistry`
 * filtered by the resident's phase and the linked manager's plan, exactly as the portal's assistant is), run
 * with the `ResidentAgentContext` `resolveResidentAgentContextForUser` re-derives on every request, so every
 * read scopes on `resident_user_id`. A write NEVER runs here: it builds its preview and parks an
 * `agent_pending_actions` row with `portal: "resident"`; the resident confirms it in PropLane, through the same
 * confirm route as the portal assistant. A bearer connection can never confirm its own proposal.
 *
 * It is still an EXTERNAL client, so `RESIDENT_EXTERNAL_EXCLUDED_TOOL_NAMES` (the resident twin of the manager
 * gateway's exclusion set) keeps the tools that carry house secrets off this surface. The catalog and the dispatch
 * both apply it, so a name that is never listed cannot be called either.
 */
import "server-only";

import { track } from "@/lib/analytics/posthog";
import { traceExternalToolCall } from "@/lib/observability/langfuse";
import { createPendingAction } from "@/lib/tools/pending-actions";
import { previewWriteTool, runReadTool, toAnthropicTools, type ToolRegistry } from "@/lib/tools/registry";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { buildResidentRegistry, residentAgentRegistry } from "@/lib/tools/resident-index";
import { RESIDENT_EXTERNAL_EXCLUDED_TOOL_NAMES } from "./capabilities";
import { CONFIRM_ACTION_TOOL_NAME, type CallToolResult, type McpToolSchema } from "./tool-types";

/** Matches the pending-action row's 15-minute default expiry. */
const PENDING_ACTION_TTL_SECONDS = 900;

function registryFor(ctx: ResidentAgentContext): ToolRegistry<ResidentAgentContext> {
  return buildResidentRegistry(ctx);
}

/** The resident catalog: every tool the portal assistant has, writes included (they only ever propose). */
export function listResidentTools(ctx: ResidentAgentContext): McpToolSchema[] {
  return toAnthropicTools(registryFor(ctx))
    .filter((t) => !RESIDENT_EXTERNAL_EXCLUDED_TOOL_NAMES.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    }));
}

async function dispatch(ctx: ResidentAgentContext, name: string, input: unknown): Promise<CallToolResult> {
  if (name === CONFIRM_ACTION_TOOL_NAME) {
    return {
      ok: false,
      error: "External connections cannot confirm actions. You approve this proposal in PropLane.",
    };
  }
  const registry = registryFor(ctx);
  const tool = RESIDENT_EXTERNAL_EXCLUDED_TOOL_NAMES.has(name) ? undefined : registry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

  if (tool.kind === "read") return runReadTool(registry, ctx, name, input);

  const previewed = await previewWriteTool(registry, ctx, name, input);
  if (!previewed.ok) return { ok: false, error: previewed.error };
  const actionId = await createPendingAction(ctx, name, previewed.input, previewed.preview, { portal: "resident" });
  if (!actionId) return { ok: false, error: "Could not stage this action. Please try again." };
  return {
    ok: true,
    data: {
      status: "awaiting_confirmation",
      actionId,
      destructive: previewed.destructive,
      expiresInSeconds: PENDING_ACTION_TTL_SECONDS,
      preview: previewed.preview,
      message: "Nothing has been done yet. Approve this preview in your PropLane resident portal.",
    },
  };
}

export async function callResidentTool(
  ctx: ResidentAgentContext,
  name: string,
  input: unknown,
  keyId = "unknown",
): Promise<CallToolResult> {
  const result = await traceExternalToolCall(
    { userId: ctx.userId, sessionId: `mcp:${keyId}`, metadata: { landlordId: ctx.landlordId, role: "resident" } },
    { toolName: name, input, transport: "mcp", keyId },
    () => dispatch(ctx, name, input),
  );
  const analyticsTool = residentAgentRegistry.has(name) ? name : "unknown";
  track("mcp_tool_called", ctx.userId, { tool: analyticsTool, ok: result.ok, transport: "mcp", portal: "resident" });
  return result;
}
