import "server-only";

/**
 * Runs the assistant's auto-reply inside a resident's / guest's conversation with their manager.
 * The decision, the allowlisted tools and the prompt are pure and live in `resident-thread-auto-reply.ts`.
 *
 * What this adds on top of that decision:
 * - The manager's switch: `message:assistant_reply:resident` in Settings -> Communication -> Messages sent
 *   automatically (per workspace). An unreadable setting fails CLOSED (no reply).
 * - Approval-first and quiet hours (`partyFacingAnswerHold`, the strict resolver): held means no answer; the manager
 *   replies as before. Escalations are still handed to the manager.
 * - Credit: a model turn reserves an `ai_agent_turn` BEFORE any model work and hands it back when nothing was sent
 *   (the fixed price answer and the hand-off line use no model and cost nothing).
 * - Scope: the turn runs as the authenticated resident (`resolveResidentInboxAgentContext`, tenant-bound to the thread's
 *   manager, identity must equal the signed-in user), on read tools only; every fact is a tool result.
 * - The reply lands in the SAME conversation as "PropLane Assistant", marked automated, once per resident message
 *   (deterministic message id), so a retry never answers twice. Best-effort: the resident's own message already went.
 * - Langfuse: `traceAgentTurn` stamps landlordId / role / channel and the prompt id (`resident-thread-auto-reply`).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { autoRespondToResidentInboxMessage, type InboxAutoReply } from "@/lib/agent/inbox-auto-respond.server";
import { PROMPT_IDS } from "@/lib/agent/prompt-metadata";
import { partyFacingAnswerHold } from "@/lib/automation-send-mode.server";
import { automatedMessageKey, type AutomatedMessageSettings } from "@/lib/automated-messages-settings";
import { loadAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { loadThreadConversation } from "@/lib/communication/conversation-key.server";
import { MANAGER_AGENT_NOTICE_FROM_NAME } from "@/lib/communication-assistant-inbox-list";
import {
  finishEmailAutoReplyCredit,
  reserveEmailAutoReplyCredit,
} from "@/lib/manager-assistant-email/email-auto-reply-credit.server";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { RESIDENT_HANDOFF_NOTICE_TYPE, RESIDENT_HANDOFF_SUBJECT } from "@/lib/resident-handoff";
import {
  ESCALATION_ACK,
  ESCALATION_LABEL,
  PRICE_FIRM_REPLY,
  RESIDENT_THREAD_AUTO_REPLY_SYSTEM_PROMPT,
  RESIDENT_THREAD_AUTO_REPLY_TOOLS,
  decideResidentThreadReply,
  isEscalationSentinel,
  type ResidentThreadDecision,
  type ResidentThreadEscalationReason,
} from "@/lib/resident-thread-auto-reply";
import { buildResidentRegistry } from "@/lib/tools/resident-index";

export const ASSISTANT_REPLY_EVENT = { domain: "message", event: "assistant_reply", audience: "resident" } as const;

export type ResidentThreadAutoReplyInput = {
  managerUserId: string;
  residentUserId: string;
  residentEmail: string;
  residentName: string;
  /** The conversation the message was written in (the resident's own copy); null = resolved by the delivery. */
  threadId: string | null;
  /** Stable id of the resident's message (its commit id); makes every write below idempotent. */
  messageId: string | null;
  text: string;
};

export type ResidentThreadAutoReplyOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "off" }
  | { outcome: "held"; escalated: boolean }
  | { outcome: "replied"; kind: "answer" | "price_firm" | "escalation_ack"; escalated: boolean }
  | { outcome: "failed"; reason: string };

export type ResidentThreadAutoReplyDeps = {
  loadSettings(managerUserId: string, workspaceId: string | null): Promise<AutomatedMessageSettings>;
  workspaceOf(threadId: string | null): Promise<string | null>;
  hold(managerUserId: string): Promise<{ hold: boolean }>;
  reserve(args: { managerUserId: string; workspaceId: string | null; key: string }): Promise<{ allowed: true; key: string } | { allowed: false; reason: string }>;
  finish(args: { managerUserId: string; key: string; replyProduced: boolean }): Promise<void>;
  respond(args: ResidentThreadAutoReplyInput): Promise<InboxAutoReply>;
  notifyManager(args: { input: ResidentThreadAutoReplyInput; reason: ResidentThreadEscalationReason | "unanswerable"; workspaceId: string | null; messageKey: string }): Promise<void>;
  deliver(args: { input: ResidentThreadAutoReplyInput; text: string; messageKey: string }): Promise<boolean>;
};

/** True only when the manager has NOT turned the switch off for this workspace (an absent row means on). */
export function assistantReplyEnabled(settings: AutomatedMessageSettings): boolean {
  const entry = settings[automatedMessageKey(ASSISTANT_REPLY_EVENT.domain, ASSISTANT_REPLY_EVENT.event, ASSISTANT_REPLY_EVENT.audience)];
  return !entry || entry.enabled !== false;
}

function messageKeyOf(input: ResidentThreadAutoReplyInput): string {
  if (input.messageId?.trim()) return input.messageId.trim();
  return createHash("sha256").update(`${input.threadId ?? ""}:${input.residentUserId}:${input.text}`).digest("hex").slice(0, 24);
}

export async function runResidentThreadAutoReply(
  input: ResidentThreadAutoReplyInput,
  deps: ResidentThreadAutoReplyDeps,
): Promise<ResidentThreadAutoReplyOutcome> {
  if (!input.managerUserId.trim() || !input.residentUserId.trim() || !input.text.trim()) return { outcome: "skipped", reason: "missing_identity" };
  const decision: ResidentThreadDecision = decideResidentThreadReply(input.text);
  if (decision.action === "skip") return { outcome: "skipped", reason: decision.reason };

  const messageKey = messageKeyOf(input);
  let workspaceId: string | null;
  try {
    workspaceId = await deps.workspaceOf(input.threadId);
    // Fail closed: a setting that cannot be read is not a yes.
    if (!assistantReplyEnabled(await deps.loadSettings(input.managerUserId, workspaceId))) return { outcome: "off" };
  } catch {
    return { outcome: "failed", reason: "settings_unreadable" };
  }

  let held = true;
  try {
    held = (await deps.hold(input.managerUserId)).hold;
  } catch {
    held = true;
  }

  const escalate = async (reason: ResidentThreadEscalationReason | "unanswerable") => {
    await deps.notifyManager({ input, reason, workspaceId, messageKey }).catch(() => undefined);
    if (held) return { outcome: "held" as const, escalated: true };
    const sent = await deps.deliver({ input, text: ESCALATION_ACK, messageKey: `${messageKey}:ack` }).catch(() => false);
    return sent ? { outcome: "replied" as const, kind: "escalation_ack" as const, escalated: true } : { outcome: "failed" as const, reason: "deliver_failed" };
  };

  if (decision.action === "escalate") return escalate(decision.reason);
  if (held) return { outcome: "held", escalated: false };

  if (decision.topic === "price_firm") {
    const sent = await deps.deliver({ input, text: PRICE_FIRM_REPLY, messageKey }).catch(() => false);
    return sent ? { outcome: "replied", kind: "price_firm", escalated: false } : { outcome: "failed", reason: "deliver_failed" };
  }

  const credit = await deps.reserve({ managerUserId: input.managerUserId, workspaceId, key: messageKey });
  if (!credit.allowed) return { outcome: "failed", reason: `credit_${credit.reason}` };
  let produced = false;
  try {
    const result = await deps.respond(input);
    if (!result.ok) return { outcome: "failed", reason: result.reason };
    const reply = result.reply.trim();
    // A write proposal has no place in a conversation with a person, and a model that found no stated answer says so
    // with the sentinel: both go to the manager instead of being improvised.
    if (!reply || result.pendingAction || isEscalationSentinel(reply)) return await escalate("unanswerable");
    const sent = await deps.deliver({ input, text: reply, messageKey });
    produced = sent;
    return sent ? { outcome: "replied", kind: "answer", escalated: false } : { outcome: "failed", reason: "deliver_failed" };
  } finally {
    await deps.finish({ managerUserId: input.managerUserId, key: credit.key, replyProduced: produced });
  }
}

/** The real dependencies, all on the service-role client. */
export function residentThreadAutoReplyDeps(db: SupabaseClient): ResidentThreadAutoReplyDeps {
  return {
    loadSettings: (managerUserId, workspaceId) => loadAutomatedMessageSettings(db, managerUserId, { workspaceId }),
    workspaceOf: async (threadId) => (threadId ? (await loadThreadConversation(db, threadId)).workspaceId : null),
    hold: (managerUserId) => partyFacingAnswerHold(db, managerUserId),
    reserve: async ({ managerUserId, workspaceId, key }) =>
      reserveEmailAutoReplyCredit(db, { managerUserId, workspaceId, inboundEmailId: key, role: "resident", channel: "inapp" }),
    finish: (args) => finishEmailAutoReplyCredit(db, args),
    respond: (input) =>
      autoRespondToResidentInboxMessage(db, {
        managerUserId: input.managerUserId,
        residentEmail: input.residentEmail,
        incomingText: input.text,
        sessionId: input.threadId ?? undefined,
        surface: {
          system: RESIDENT_THREAD_AUTO_REPLY_SYSTEM_PROMPT,
          promptId: PROMPT_IDS.residentThreadAutoReply,
          traceName: "resident-thread-auto-reply",
          registryFor: buildResidentRegistry,
          toolNames: RESIDENT_THREAD_AUTO_REPLY_TOOLS,
          expectedUserId: input.residentUserId,
        },
      }),
    notifyManager: async ({ input, reason, workspaceId, messageKey }) => {
      const name = input.residentName.trim() || "A resident";
      const what = reason === "unanswerable" ? "a question the assistant could not answer" : ESCALATION_LABEL[reason];
      await notifyManagerFromAgent(db, {
        landlordId: input.managerUserId,
        subject: RESIDENT_HANDOFF_SUBJECT,
        text: `${name} wrote about ${what}. The assistant did not answer it. Their message is in your inbox.`,
        externalText: RESIDENT_HANDOFF_SUBJECT,
        threadType: RESIDENT_HANDOFF_NOTICE_TYPE,
        url: "/portal/communication/active",
        category: "messages",
        notify: { push: true, sms: false },
        workspaceId,
        idempotencyKey: `thread-auto-reply-handoff:${createHash("sha256").update(`${input.residentUserId}:${input.managerUserId}:${messageKey}`).digest("hex").slice(0, 32)}`,
      });
    },
    deliver: async ({ input, text, messageKey }) => {
      const { data: manager } = await db.from("profiles").select("email").eq("id", input.managerUserId).maybeSingle();
      const managerEmail = String(manager?.email ?? "").trim().toLowerCase();
      if (!managerEmail) return false;
      const result = await deliverPortalInboxMessage(db, {
        senderUserId: input.managerUserId,
        senderEmail: managerEmail,
        // The label the resident reads on the bubble: the assistant speaking, never the manager's own name.
        fromName: MANAGER_AGENT_NOTICE_FROM_NAME,
        subject: "PropLane Assistant",
        text,
        toUserIds: [input.residentUserId],
        eventCategory: "messages",
        senderRole: "manager",
        automated: true,
        // Deterministic: the same resident message is answered at most once, whatever retries.
        messageId: `assistant-reply:${input.managerUserId}:${input.residentUserId}:${messageKey}`,
      });
      return result.ok;
    },
  };
}
