/**
 * The one confirm-gate executor. Claim a proposed action, re-look-up the tool
 * from the CALLING portal's registry, re-validate the STORED input against the
 * tool's current Zod schema, and run the handler. Client/model-supplied
 * arguments are never trusted at confirm time — only the action id is.
 *
 * Shared by all three chat routes and the standalone tour-proposal approval
 * route so every surface goes through exactly the same gate.
 */
import type { AgentContext } from "./context";
import { agentRegistry } from "./index";
import { executeWriteTool, type ToolRegistry } from "./registry";
import {
  claimPendingAction,
  markPendingActionFailed,
  peekPendingActionPortal,
  type AgentPortal,
  type PendingActionActor,
} from "./pending-actions";
import { traceAgentAction } from "@/lib/observability/langfuse";
import { currentSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import { sameSmsTestProvenance } from "@/lib/sms/sms-test-provenance";
import { isTestWorkspaceFeatureEnabled, resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export type ConfirmGateResult =
  | {
      ok: true;
      reply: string;
      toolName: string;
      sessionId: string | null;
      proposalTraceId: string | null;
      checkoutUrl?: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Confirm one pending action for a portal. `registry` and `portal` must be the
 * CALLER's, not the row's: the row names the portal it was proposed from, and a
 * mismatch is refused rather than executed against another portal's tool of the
 * same name (schedule_message exists in both the manager and resident maps).
 *
 * The portal is checked BEFORE the claim. Claiming first would burn the row —
 * a dual-role user's still-valid resident proposal would be destroyed by a
 * stray manager-side confirm instead of staying approvable from its own portal.
 * The peek is actor-scoped, so it leaks nothing a foreign caller could not
 * already learn from the uniform 410, and it fails CLOSED: a peek that could
 * not be read refuses without claiming, because an unreadable row is not a
 * missing one and must not fall through to the claim that would burn it.
 */
export async function runConfirmedPendingActionForPortal<Ctx extends PendingActionActor>(
  ctx: Ctx,
  registry: ToolRegistry<Ctx>,
  portal: AgentPortal,
  actionId: string,
  traceMetadata: Record<string, unknown> = {},
): Promise<ConfirmGateResult> {
  const peeked = await peekPendingActionPortal(ctx, actionId);
  if (peeked.state === "unreadable") {
    return { ok: false, status: 503, error: "This action could not be confirmed right now. Please try again." };
  }
  if (peeked.state === "found" && peeked.portal !== portal) {
    return { ok: false, status: 400, error: "This action could not be executed." };
  }
  const currentTestProvenance = currentSmsTestProvenance();
  if (currentTestProvenance?.workspaceId) {
    const classification = await resolveTestWorkspaceClassification(ctx.userId, ctx.db);
    if (
      !isTestWorkspaceFeatureEnabled() ||
      classification.kind !== "classified" ||
      classification.state !== "active" ||
      classification.workspaceId !== currentTestProvenance.workspaceId
    ) {
      return { ok: false, status: 410, error: "This action is no longer available. Ask the assistant again." };
    }
  }
  if (peeked.state === "found" && (
    Boolean(peeked.smsTestProvenance) !== Boolean(currentTestProvenance) ||
    (peeked.smsTestProvenance !== null && !sameSmsTestProvenance(peeked.smsTestProvenance, currentTestProvenance))
  )) {
    return { ok: false, status: 410, error: "This action is no longer available. Ask the assistant again." };
  }
  const claimed = await claimPendingAction(ctx, actionId);
  if (!claimed) {
    return { ok: false, status: 410, error: "This action is no longer available. Ask the assistant again." };
  }
  if (claimed.portal !== portal) {
    await markPendingActionFailed(ctx, actionId);
    return { ok: false, status: 400, error: "This action could not be executed." };
  }
  const tool = registry.get(claimed.toolName);
  if (!tool || tool.kind !== "write") {
    await markPendingActionFailed(ctx, actionId);
    return { ok: false, status: 400, error: "This action could not be executed." };
  }

  // executeWriteTool re-validates the stored input against the tool's CURRENT
  // schema (so schema drift across deploys fails safely) and the handler
  // re-resolves every target from live, actor-scoped data before writing.
  const executed = await traceAgentAction(
    { userId: ctx.userId, metadata: traceMetadata },
    {
      toolName: claimed.toolName,
      actionId,
      decision: "confirm",
      proposalTraceId: claimed.proposalTraceId,
    },
    () => executeWriteTool(registry, ctx, claimed.toolName, claimed.input),
  );
  if (!executed.ok) {
    // The claim already flipped the row to "executed"; record the truth. The
    // user re-asks for a fresh proposal (no blind retry of a possibly
    // partially-executed handler).
    await markPendingActionFailed(ctx, actionId);
    return { ok: false, status: 400, error: executed.error };
  }
  return {
    ok: true,
    reply: executed.result.reply,
    toolName: claimed.toolName,
    sessionId: claimed.sessionId,
    proposalTraceId: claimed.proposalTraceId,
    ...(executed.result.checkoutUrl ? { checkoutUrl: executed.result.checkoutUrl } : {}),
  };
}

/** Manager-portal shorthand: the manager registry and the "manager" portal. */
export async function runConfirmedPendingAction(
  ctx: AgentContext,
  actionId: string,
): Promise<ConfirmGateResult> {
  return runConfirmedPendingActionForPortal(ctx, agentRegistry, "manager", actionId, {
    landlordId: ctx.landlordId,
    role: "manager",
  });
}
