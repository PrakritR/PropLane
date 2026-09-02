/**
 * Auto-reply to a resident's Communication message.
 *
 * This is what turns the Communication tab from a mailbox into something that
 * answers. The resident asks in their own words; the agent answers from TOOL
 * RESULTS — balances, dates, statuses come from the tool layer, never from the
 * model's own generation — and anything that would change state stops as a
 * proposal for a human to confirm.
 *
 * Safety posture, all of it inherited rather than reinvented:
 *
 * - The actor comes from the THREAD (its owner manager and participant email),
 *   never from anything written in the message body. Resident text is untrusted
 *   input that may contain prompt-injection attempts.
 * - `allowWriteTools` is deliberately empty. Every write tool the resident
 *   registry has therefore halts the turn as a `pendingAction` instead of
 *   executing, which is the same gate the chat surfaces use.
 * - `readOnly` is NOT set, because unlike the SMS agents there IS a place to
 *   show a proposal — the resident's own pending-actions surface. Setting it
 *   would hide write tools entirely and make the assistant unable to offer to
 *   do anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn, type PendingActionProposal } from "@/lib/agent/loop";
import { RESIDENT_INBOX_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { traceAgentTurn } from "@/lib/observability/langfuse";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import { resolveResidentInboxAgentContext } from "@/lib/tools/resident-inbox-context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

/** How much of the thread the model sees. Enough for context, bounded for cost. */
export const MAX_HISTORY_MESSAGES = 12;

export type InboxTurnMessage = {
  /** "resident" for the person writing in, anything else is treated as the manager side. */
  from: "resident" | "manager";
  body: string;
};

export type InboxAutoReply =
  | {
      ok: true;
      reply: string;
      /**
       * Present when the turn halted on a write proposal. The loop does NOT
       * persist it — the caller stores it with `createPendingAction` so the
       * resident can confirm, exactly as the chat routes do. Returning the raw
       * proposal keeps this module free of a second persistence path.
       */
      pendingAction?: PendingActionProposal;
      model: string;
      traceId: string | null;
    }
  | { ok: false; reason: string };

/**
 * Trim thread history to the last N turns, oldest first.
 *
 * Exported for tests: the ordering matters, because handing the model a
 * reversed transcript makes it answer the wrong question confidently.
 */
export function buildTurnMessages(
  history: readonly InboxTurnMessage[],
  incoming: string,
): { role: "user" | "assistant"; content: string }[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  const messages = recent
    .filter((entry) => entry.body.trim())
    .map((entry) => ({
      // The resident is the "user" of this conversation; the manager side and
      // any previous assistant reply are what came back.
      role: entry.from === "resident" ? ("user" as const) : ("assistant" as const),
      content: entry.body.trim(),
    }));
  messages.push({ role: "user", content: incoming.trim() });
  return messages;
}

export async function autoRespondToResidentInboxMessage(
  db: SupabaseClient,
  input: {
    /** Owner of the thread — the tenant binding for the resident's scope. */
    managerUserId: string;
    residentEmail: string;
    incomingText: string;
    history?: readonly InboxTurnMessage[];
    sessionId?: string;
  },
): Promise<InboxAutoReply> {
  const incoming = input.incomingText.trim();
  if (!incoming) return { ok: false, reason: "empty_message" };

  const identity = await resolveResidentInboxAgentContext(db, {
    residentEmail: input.residentEmail,
    ownerManagerUserId: input.managerUserId,
  });
  if (!identity.ok) return { ok: false, reason: identity.reason };

  const messages = buildTurnMessages(input.history ?? [], incoming);

  try {
    let traceId: string | null = null;
    const result = await traceAgentTurn(
      {
        userId: identity.ctx.userId,
        metadata: {
          landlordId: identity.ctx.landlordId || identity.ctx.userId,
          role: "resident",
          managerIds: [input.managerUserId],
          channel: "inbox",
        },
      },
      messages,
      (observer) =>
        runAgentTurn<ResidentAgentContext>({
          ctx: identity.ctx,
          registry: residentAgentRegistry,
          system: RESIDENT_INBOX_SYSTEM_PROMPT,
          messages: messages as Parameters<typeof runAgentTurn>[0]["messages"],
          observer,
          // Empty on purpose. Every write proposes.
          allowWriteTools: [],
        }),
      {
        name: "resident-inbox-agent-turn",
        sessionId: input.sessionId,
        promptMeta: resolvePromptMeta(PROMPT_IDS.residentInboxAgent, RESIDENT_INBOX_SYSTEM_PROMPT),
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
    const reply = result.reply.trim();
    if (!reply && !result.pendingAction) return { ok: false, reason: "empty_reply" };
    return {
      ok: true,
      reply,
      pendingAction: result.pendingAction,
      model: result.model,
      traceId,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "agent_turn_failed" };
  }
}
