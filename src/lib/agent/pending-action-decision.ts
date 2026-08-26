/**
 * The confirm/deny branch every portal chat route shares.
 *
 * The client posts ONLY `{ confirmActionId }` or `{ denyActionId }` back to the
 * same auth-gated chat endpoint it proposed from. Nothing else in the body is
 * read: the tool name and its input come from the server-stored proposal
 * (Zod-validated at propose time, re-validated at confirm time), and the
 * handler re-resolves current state itself.
 *
 * Factored out so the three surfaces cannot drift apart on the
 * security-relevant parts.
 */
import { NextResponse } from "next/server";
import {
  runConfirmedPendingActionForPortal,
  type ConfirmGateResult,
} from "@/lib/tools/confirm-gate.server";
import {
  denyPendingAction,
  peekPendingActionPortal,
  type AgentPortal,
  type PendingActionActor,
} from "@/lib/tools/pending-actions";
import type { ToolRegistry } from "@/lib/tools/registry";
import { appendAgentMessages } from "@/lib/agent/sessions";
import { track } from "@/lib/analytics/posthog";
import { formatAgentChatUserError } from "@/lib/agent/assistant-turn-error";
import { scoreActionApproval, traceAgentAction } from "@/lib/observability/langfuse";

type DecisionActor = PendingActionActor & { landlordId: string };

export type PendingActionDecisionResult =
  | { kind: "denied"; reply: string; known: boolean }
  | { kind: "confirmed"; result: ConfirmGateResult };

/**
 * Transport-neutral pending-action decision. Portal HTTP routes and SMS both
 * use this so trace/scoring behavior cannot drift by surface.
 */
export async function decidePendingAction<Ctx extends DecisionActor>(args: {
  action: { kind: "deny" | "confirm"; actionId: string };
  ctx: Ctx;
  registry: ToolRegistry<Ctx>;
  portal: AgentPortal;
  traceMetadata?: Record<string, unknown>;
}): Promise<PendingActionDecisionResult> {
  const { action, ctx, registry, portal } = args;
  const traceMetadata = args.traceMetadata ?? { portal };

  if (action.kind === "deny") {
    // Denial is a state change too. Check the portal before resolving the row,
    // just like the confirm gate does, so a dual-role user cannot discard a
    // resident proposal from the manager surface (or vice versa) by id.
    const peeked = await peekPendingActionPortal(ctx, action.actionId);
    const denied = peeked.state === "found" && peeked.portal === portal
      ? await denyPendingAction(ctx, action.actionId)
      : null;
    track("assistant_action_denied", ctx.userId, { portal, known: !!denied });
    if (denied) {
      await traceAgentAction(
        { userId: ctx.userId, metadata: traceMetadata },
        {
          toolName: denied.toolName,
          actionId: action.actionId,
          decision: "cancel",
          proposalTraceId: denied.proposalTraceId,
        },
        async () => ({ ok: true as const, result: { reply: "denied" } }),
      );
      if (denied.proposalTraceId) {
        await scoreActionApproval({
          traceId: denied.proposalTraceId,
          approved: false,
          actionId: action.actionId,
          toolName: denied.toolName,
        });
      }
    }
    return {
      kind: "denied",
      reply: denied
        ? "Okay, cancelled. Nothing was sent or changed."
        : "This action could not be cancelled. It may no longer be available.",
      known: Boolean(denied),
    };
  }

  const result = await runConfirmedPendingActionForPortal(
    ctx,
    registry,
    portal,
    action.actionId,
    traceMetadata,
  );
  if (result.ok) {
    track("assistant_action_confirmed", ctx.userId, { portal, action: result.toolName });
    if (result.proposalTraceId) {
      await scoreActionApproval({
        traceId: result.proposalTraceId,
        approved: true,
        actionId: action.actionId,
        toolName: result.toolName,
      });
    }
  }
  return { kind: "confirmed", result };
}

/**
 * Handle a confirm/deny body, or return null when the request is an ordinary
 * chat turn. Callers must invoke this BEFORE running a model turn.
 */
export async function handlePendingActionDecision<Ctx extends DecisionActor>(args: {
  body: Record<string, unknown>;
  ctx: Ctx;
  registry: ToolRegistry<Ctx>;
  portal: AgentPortal;
  traceMetadata?: Record<string, unknown>;
}): Promise<NextResponse | null> {
  const { body, ctx, registry, portal } = args;
  const traceMetadata = args.traceMetadata ?? { portal };

  if (typeof body.denyActionId === "string") {
    const decision = await decidePendingAction({
      action: { kind: "deny", actionId: body.denyActionId },
      ctx,
      registry,
      portal,
      traceMetadata,
    });
    return NextResponse.json({ reply: decision.kind === "denied" ? decision.reply : "Okay, cancelled." });
  }

  if (typeof body.confirmActionId !== "string") return null;

  let result: ConfirmGateResult;
  try {
    const decision = await decidePendingAction({
      action: { kind: "confirm", actionId: body.confirmActionId },
      ctx,
      registry,
      portal,
      traceMetadata,
    });
    result = decision.kind === "confirmed" ? decision.result : { ok: false, status: 410, error: "Action unavailable." };
  } catch (e) {
    console.error(`[agent/${portal}] confirm action failed:`, e);
    const { message, httpStatus } = formatAgentChatUserError(e);
    return NextResponse.json({ error: message }, { status: httpStatus });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await appendAgentMessages(ctx, portal, result.sessionId, [
    { role: "assistant", content: result.reply, toolTrace: { tools: [{ tool: result.toolName, ok: true }] } },
  ]);
  return NextResponse.json({
    reply: result.reply,
    toolTrace: [{ tool: result.toolName, ok: true }],
    ...(result.checkoutUrl ? { checkoutUrl: result.checkoutUrl } : {}),
  });
}
