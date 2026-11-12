import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { findOrCreatePortalAssistantSmsSession } from "@/lib/agent/sms-agent-turn.server";
import { issueSmsConfirmationCode, withConfirmationCode } from "@/lib/sms/confirmation-code";
import {
  renderPreviewForSms,
  SMS_PENDING_ACTION_TTL_MS,
  supersedeOpenSmsProposals,
} from "@/lib/sms/agent-confirmation.server";
import { buildManagerSmsRegistry } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";
import { createPendingActionForUser } from "@/lib/tools/pending-actions";
import { previewWriteTool } from "@/lib/tools/registry";

export type ProposeResult = { ok: true; reply: string; actionId: string } | { ok: false; reply: string };

/** One short line out of a tool's own error text. */
function oneLine(message: string): string {
  const first = message.split(/\n+/)[0]?.trim() || "I could not set that up.";
  return first.length > 240 ? `${first.slice(0, 237)}...` : first;
}

/**
 * Propose ONE write through the typed tool layer, exactly as the manager agent would: the tool's own preview is what
 * the manager reads, the proposal is stored as the one open pending action of their text session, and on the PropLane
 * line it carries the 4-digit code the confirming reply must repeat ("Reply YES 4821"). The confirmation itself is the
 * existing turn handler (`handleConfirmationReply`), so the executed write is the tool's handler, unchanged.
 *
 * The registry is the manager SMS registry for THIS context: a tool the seat may not use (read-only seat, delegated
 * grant, destructive) is simply absent, and the command says so instead of writing.
 */
export async function proposeToolWrite(
  db: SupabaseClient,
  ctx: AgentContext,
  input: { toolName: string; input: unknown; requireConfirmationCode: boolean },
): Promise<ProposeResult> {
  const registry = buildManagerSmsRegistry(ctx.managerSmsAccess);
  if (!registry.has(input.toolName)) {
    return { ok: false, reply: "I can not change that by text for your access. Please do it in PropLane." };
  }
  const prepared = await previewWriteTool(registry, ctx, input.toolName, input.input);
  if (!prepared.ok) return { ok: false, reply: oneLine(prepared.error) };

  const session = await findOrCreatePortalAssistantSmsSession(db, { actorUserId: ctx.userId, workspaceId: ctx.workspace?.id ?? null });
  if (!session) return { ok: false, reply: "I could not set that up just now. Please try again in a moment." };
  const cleared = await supersedeOpenSmsProposals(db, { userId: ctx.userId, portal: "manager", sessionId: session.id });
  if (!cleared.ok) return { ok: false, reply: "I could not set that up just now. Please try again in a moment." };

  const actionId = await createPendingActionForUser(db as Parameters<typeof createPendingActionForUser>[0], {
    landlordId: ctx.landlordId,
    userId: ctx.userId,
    toolName: input.toolName,
    input: prepared.input,
    preview: prepared.preview,
    portal: "manager",
    sessionId: session.id,
    expiresInMs: SMS_PENDING_ACTION_TTL_MS,
  });
  if (!actionId) return { ok: false, reply: "I could not set that up just now. Please try again in a moment." };

  const rendered = renderPreviewForSms(prepared.preview);
  if (!input.requireConfirmationCode) return { ok: true, reply: rendered, actionId };
  const code = await issueSmsConfirmationCode(db, { kind: "pending_action", subjectId: actionId });
  if (!code) {
    // No code means no coded confirmation: withdraw the proposal rather than leave one a bare YES could answer.
    await supersedeOpenSmsProposals(db, { userId: ctx.userId, portal: "manager", sessionId: session.id });
    return { ok: false, reply: "I could not set that up just now. Please do it in PropLane." };
  }
  return { ok: true, reply: withConfirmationCode(rendered, code), actionId };
}

/** Deny every open proposal of this actor's text session (a cancelled flow must not leave a YES that still saves). */
export async function withdrawOpenProposals(db: SupabaseClient, ctx: AgentContext): Promise<void> {
  try {
    const session = await findOrCreatePortalAssistantSmsSession(db, { actorUserId: ctx.userId, workspaceId: ctx.workspace?.id ?? null });
    if (session) await supersedeOpenSmsProposals(db, { userId: ctx.userId, portal: "manager", sessionId: session.id });
  } catch {
    /* the pending action also expires by itself */
  }
}
