/**
 * The resident SMS agent: one inbound text from a VERIFIED resident becomes one
 * outbound reply, with the resident portal's full tool catalog behind it.
 *
 * Same six-step shape as the leasing SMS agent (session → history → context →
 * traced turn → persist → caller sends), with four deliberate differences:
 *
 *  - Identity comes from {@link resolveResidentSmsAgentContext}, which requires
 *    a verified phone AND that the texted work number's owner is one of this
 *    resident's managers. This module NEVER resolves identity itself; it is
 *    handed a context that already passed that gate.
 *  - The registry is the resident portal's own, so every tool's existing
 *    `ctx.userId` / `ctx.email` scoping applies unchanged. That is what keeps a
 *    manager's scheduled message invisible here: `get_my_scheduled_messages`
 *    filters on `senderPortal = 'resident'` AND `senderUserId = ctx.userId`.
 *  - Writes are NOT allow-listed for inline execution. The loop proposes, this
 *    module texts the proposal, and the resident's reply confirms it. Nothing
 *    executes without that round trip.
 *  - A confirmation reply short-circuits the model entirely: "YES" must never be
 *    re-interpreted by an LLM, it addresses the one open proposal or nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "@/lib/agent/loop";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { createPendingActionForUser } from "@/lib/tools/pending-actions";
import { decidePendingAction } from "@/lib/agent/pending-action-decision";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { traceAgentTurn, type TraceActor } from "@/lib/observability/langfuse";
import { track } from "@/lib/analytics/posthog";
import {
  classifySmsConfirmationReply,
  renderPreviewForSms,
  resolveOpenSmsProposal,
  supersedeOpenSmsProposals,
  SMS_PENDING_ACTION_TTL_MS,
} from "@/lib/sms/agent-confirmation.server";

type Db = SupabaseClient;

const SESSION_KIND = "resident_sms";
const SESSION_COLUMNS = "id, landlord_id, kind, vendor_phone_e164, status, user_id";
const HISTORY_LIMIT = 24;
const MAX_INBOUND_PER_HOUR = 30;
/** Texts are read on a phone; keep replies inside a couple of segments. */
const MAX_REPLY_CHARS = 1200;

export type ResidentSmsSessionRow = {
  id: string;
  landlord_id: string;
  kind: string;
  vendor_phone_e164: string | null;
  status: string;
  user_id: string | null;
};

/** Merge consecutive same-role rows; drop a leading assistant turn for API alternation. */
function buildAlternatingHistory(
  rows: { role: string; content: string }[],
): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of rows) {
    const role = row.role === "assistant" ? "assistant" : "user";
    const content = row.content.trim();
    if (!content) continue;
    const last = out.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n${content}`;
    else out.push({ role, content });
  }
  while (out[0] && out[0].role === "assistant") out.shift();
  return out as Anthropic.MessageParam[];
}

/**
 * The session is keyed on the OWNING MANAGER, verified resident user and phone:
 * one person renting from two managers holds two conversations, while a phone
 * later verified by a different user cannot inherit the prior user's history.
 */
export async function findOrCreateResidentSmsSession(
  db: Db,
  args: { landlordId: string; residentUserId: string; residentPhoneE164: string },
): Promise<ResidentSmsSessionRow | null> {
  const landlordId = args.landlordId.trim();
  const phone = args.residentPhoneE164.trim();
  if (!landlordId || !phone || !args.residentUserId.trim()) return null;

  const { data: existing } = await db
    .from("agent_sessions")
    .select(SESSION_COLUMNS)
    .eq("kind", SESSION_KIND)
    .eq("landlord_id", landlordId)
    .eq("user_id", args.residentUserId)
    .eq("vendor_phone_e164", phone)
    .maybeSingle();
  if (existing) {
    const row = existing as ResidentSmsSessionRow;
    if (row.status === "closed") {
      await db
        .from("agent_sessions")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      return { ...row, status: "active" };
    }
    return row;
  }

  const { data: created, error } = await db
    .from("agent_sessions")
    .insert({
      landlord_id: landlordId,
      user_id: args.residentUserId,
      kind: SESSION_KIND,
      vendor_phone_e164: phone,
      status: "active",
    })
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await db
        .from("agent_sessions")
        .select(SESSION_COLUMNS)
        .eq("kind", SESSION_KIND)
        .eq("landlord_id", landlordId)
        .eq("user_id", args.residentUserId)
        .eq("vendor_phone_e164", phone)
        .maybeSingle();
      return (raced as ResidentSmsSessionRow | null) ?? null;
    }
    console.error("resident-sms session create failed", error.message);
    return null;
  }
  return (created as ResidentSmsSessionRow | null) ?? null;
}

export type ResidentSmsTurn = {
  reply: string;
  sessionId: string;
  inboundMessageId?: string | null;
  assistantMessageId?: string | null;
  pendingActionId?: string | null;
  traceId?: string | null;
  /** Set when this turn ended by texting a write proposal awaiting YES/NO. */
  awaitingConfirmation?: boolean;
};

/** ID-only Langfuse attribution; never include the resident phone or message. */
export function residentSmsTraceActor(
  ctx: ResidentAgentContext,
  ownerManagerUserId: string,
): TraceActor {
  return {
    userId: ctx.userId,
    metadata: {
      landlordId: ctx.landlordId,
      role: "resident",
      managerIds: [ownerManagerUserId],
      activeManagerId: ownerManagerUserId,
      channel: "sms",
    },
  };
}

async function recordAssistantReply(
  db: Db,
  session: ResidentSmsSessionRow,
  reply: string,
  toolTrace: unknown = [],
  traceId?: string | null,
): Promise<string | null> {
  const { data } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "assistant",
    content: reply,
    channel: "agent",
    tool_trace: toolTrace,
    trace_id: traceId ?? null,
  }).select("id").maybeSingle();
  await db.from("agent_sessions").update({ updated_at: new Date().toISOString() }).eq("id", session.id);
  return data?.id ? String(data.id) : null;
}

/**
 * Handle a YES/NO reply against the single open proposal.
 *
 * Deliberately runs BEFORE any model call: an affirmative is an authorization,
 * not a prompt, and must not be re-interpreted. Returns null when the message
 * was not a confirmation, so the caller falls through to a normal turn.
 */
async function handleConfirmationReply(
  db: Db,
  ctx: ResidentAgentContext,
  session: ResidentSmsSessionRow,
  body: string,
  registry: ReturnType<typeof buildResidentRegistry>,
): Promise<ResidentSmsTurn | null> {
  const intent = classifySmsConfirmationReply(body);
  if (intent === "none") return null;

  const open = await resolveOpenSmsProposal(db, {
    userId: ctx.userId,
    portal: "resident",
    sessionId: session.id,
  });
  if (open.status === "unavailable") {
    return { reply: "I could not check that just now. Please try again in a moment.", sessionId: session.id };
  }
  if (open.status === "none") {
    // A bare yes/no with nothing pending is conversation, not an authorization.
    return null;
  }
  if (open.status === "ambiguous") {
    return {
      reply: "I have more than one request open, so I do not want to guess. Tell me which one to go ahead with.",
      sessionId: session.id,
    };
  }

  if (intent === "deny") {
    const decision = await decidePendingAction({
      action: { kind: "deny", actionId: open.actionId },
      ctx,
      registry,
      portal: "resident",
      traceMetadata: {
        landlordId: ctx.landlordId,
        role: "resident",
        managerIds: [session.landlord_id],
        activeManagerId: session.landlord_id,
        channel: "sms",
        sessionId: session.id,
      },
    });
    const reply = decision.kind === "denied" && decision.known
      ? "No problem, I have cancelled that. Anything else?"
      : "I could not cancel that just now. Please try again.";
    const assistantMessageId = await recordAssistantReply(db, session, reply);
    return { reply, sessionId: session.id, assistantMessageId, pendingActionId: open.actionId };
  }

  // One executor for every surface: it re-checks the portal, re-validates the
  // STORED input against the tool's current schema, and scores the decision.
  const decision = await decidePendingAction({
    action: { kind: "confirm", actionId: open.actionId },
    ctx,
    registry,
    portal: "resident",
    traceMetadata: {
      landlordId: ctx.landlordId,
      role: "resident",
      managerIds: [session.landlord_id],
      activeManagerId: session.landlord_id,
      channel: "sms",
      sessionId: session.id,
    },
  });
  const executed = decision.kind === "confirmed"
    ? decision.result
    : { ok: false as const, status: 410, error: "That request is no longer available." };
  const reply = executed.ok
    ? [executed.reply, executed.checkoutUrl].filter(Boolean).join("\n\n").slice(0, MAX_REPLY_CHARS)
    : executed.error;
  const assistantMessageId = await recordAssistantReply(db, session, reply);
  return { reply, sessionId: session.id, assistantMessageId, pendingActionId: open.actionId };
}

/**
 * Run one resident-SMS turn. Returns null when suppressed (no API key, empty
 * body, hourly cap) so the caller can stay silent rather than send filler.
 *
 * `ctx` must come from `resolveResidentSmsAgentContext`. Passing a context built
 * any other way would hand the resident tool catalog to an unverified texter.
 */
export async function runResidentSmsAgentTurn(
  db: Db,
  args: {
    ctx: ResidentAgentContext;
    ownerManagerUserId: string;
    residentPhoneE164: string;
    inboundText: string;
    inboundMessageSid?: string | null;
  },
): Promise<ResidentSmsTurn | null> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;
  const text = args.inboundText.trim().slice(0, 2000);
  if (!text) return null;
  if (args.ctx.activeManagerId !== args.ownerManagerUserId) {
    console.error("resident-sms turn refused: active manager mismatch", args.ctx.userId);
    return null;
  }
  const registry = buildResidentRegistry(args.ctx);

  const session = await findOrCreateResidentSmsSession(db, {
    landlordId: args.ownerManagerUserId,
    residentUserId: args.ctx.userId,
    residentPhoneE164: args.residentPhoneE164,
  });
  if (!session) return null;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db
    .from("agent_messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", session.id)
    .eq("role", "user")
    .gte("created_at", oneHourAgo);
  if ((count ?? 0) >= MAX_INBOUND_PER_HOUR) {
    console.error("resident-sms turn suppressed: hourly cap", session.id);
    return null;
  }

  const inboundMessageSid = args.inboundMessageSid?.trim() || null;
  const { data: insertedInbound, error: inboundInsertError } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "user",
    content: text,
    channel: "sms",
    source_message_sid: inboundMessageSid,
  }).select("id").maybeSingle();
  let inboundMessageId = insertedInbound?.id ? String(insertedInbound.id) : null;
  if (inboundInsertError?.code === "23505" && inboundMessageSid) {
    const { data: existingInbound } = await db
      .from("agent_messages")
      .select("id")
      .eq("source_message_sid", inboundMessageSid)
      .eq("role", "user")
      .maybeSingle();
    inboundMessageId = existingInbound?.id ? String(existingInbound.id) : null;
  } else if (inboundInsertError) {
    console.error("resident-sms inbound message persistence failed", session.id, inboundInsertError.message);
    return null;
  }
  track("resident_sms_message_in", args.ctx.userId, { channel: "sms" });

  const confirmation = await handleConfirmationReply(db, args.ctx, session, text, registry);
  if (confirmation) return { ...confirmation, inboundMessageId };

  const { data: historyRows } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", session.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = buildAlternatingHistory(
    ((historyRows ?? []) as { role: string; content: string }[]).reverse(),
  );
  if (history.length === 0 || history.at(-1)!.role !== "user") {
    history.push({ role: "user", content: text });
  }

  let traceId: string | null = null;
  let result;
  try {
    const system = residentSmsSystemPrompt();
    result = await traceAgentTurn(
      residentSmsTraceActor(args.ctx, args.ownerManagerUserId),
      history as { role: string; content: string }[],
      (observer) =>
        runAgentTurn<ResidentAgentContext>({
          ctx: args.ctx,
          registry,
          messages: history,
          observer,
          system,
          // Writes stay un-allow-listed on purpose: the loop proposes, the
          // resident confirms by text. Nothing here executes inline.
          readOnly: false,
        }),
      {
        name: "resident-sms-agent-turn",
        sessionId: session.id,
        promptMeta: resolvePromptMeta(PROMPT_IDS.residentSmsAgent, system),
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
  } catch (e) {
    console.error("resident-sms agent turn failed", session.id, e);
    return null;
  }

  if (result.pendingAction) {
    // One open proposal at a time, so a later bare "YES" is unambiguous.
    const cleared = await supersedeOpenSmsProposals(db, {
      userId: args.ctx.userId,
      portal: "resident",
      sessionId: session.id,
    });
    if (!cleared.ok) {
      return {
        reply: "I could not set that up just now. Please try again in a moment.",
        sessionId: session.id,
      };
    }
    const actionId = await createPendingActionForUser(db, {
      landlordId: args.ctx.landlordId,
      userId: args.ctx.userId,
      toolName: result.pendingAction.toolName,
      input: result.pendingAction.input,
      preview: result.pendingAction.preview,
      portal: "resident",
      sessionId: session.id,
      expiresInMs: SMS_PENDING_ACTION_TTL_MS,
      proposalTraceId: traceId,
    });
    if (!actionId) {
      return {
        reply: "I could not set that up just now. Please try again in a moment.",
        sessionId: session.id,
      };
    }
    const reply = [result.reply.trim(), renderPreviewForSms(result.pendingAction.preview)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_REPLY_CHARS);
    const assistantMessageId = await recordAssistantReply(db, session, reply, result.toolTrace, traceId);
    track("resident_sms_action_proposed", args.ctx.userId, {
      channel: "sms",
      tool: result.pendingAction.toolName,
    });
    return {
      reply,
      sessionId: session.id,
      inboundMessageId,
      assistantMessageId,
      pendingActionId: actionId,
      traceId,
      awaitingConfirmation: true,
    };
  }

  const reply = result.reply.trim().slice(0, MAX_REPLY_CHARS);
  if (!reply) return null;
  const assistantMessageId = await recordAssistantReply(db, session, reply, result.toolTrace, traceId);
  track("resident_sms_message_out", args.ctx.userId, {
    channel: "sms",
    tools: result.toolTrace.length,
  });
  return { reply, sessionId: session.id, inboundMessageId, assistantMessageId, traceId };
}

/**
 * Send the resident agent's reply from the manager's work number.
 *
 * The conversation key uses role `resident` and the resident's USER ID as the
 * person ref, so this thread stays distinct from the prospect thread the same
 * phone may already own from before they applied.
 */
export async function deliverResidentSmsReply(args: {
  ownerManagerUserId: string;
  residentUserId: string;
  toPhone: string;
  text: string;
  workNumber?: string | null;
  inboundMessageSid?: string | null;
  traceId?: string | null;
}): Promise<import("@/lib/proplane-sms-transport.server").PropLaneSmsResult> {
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const { buildConversationKey } = await import("@/lib/sms-conversation-identity");
  return sendFromManagerWorkNumber({
    managerUserId: args.ownerManagerUserId,
    to: args.toPhone,
    text: args.text,
    fromNumber: args.workNumber,
    source: "automated",
    counterpartyRole: "resident",
    residentUserId: args.residentUserId,
    conversationKey: buildConversationKey({
      ownerManagerUserId: args.ownerManagerUserId,
      role: "resident",
      counterpartyUserId: args.residentUserId,
      counterpartyPhone: args.toPhone,
    }),
    dedupeKey: args.inboundMessageSid?.trim()
      ? `inbound_reply_${args.inboundMessageSid.trim()}`
      : null,
    purpose: "manager_conversation",
    actorUserId: args.residentUserId,
    traceId: args.traceId,
  });
}

function residentSmsSystemPrompt(): string {
  return [
    "You are PropLane's assistant, texting with a resident on their property manager's work number.",
    "You are talking to the resident themselves; their identity is already verified, so never ask them to prove who they are.",
    "",
    "Keep replies short enough to read on a phone: a couple of sentences, no markdown, no bullet lists, no links unless a tool returned one.",
    "Every fact about money, dates, leases and requests must come from a tool result. Never estimate, recall or invent a number.",
    "If a tool returns nothing, say you could not find it and offer to pass a message to their manager.",
    "",
    "When the resident asks you to do something that changes anything, call the tool straight away.",
    "Do NOT ask 'does that sound right?' first. The system shows them the exact details and asks them to reply YES before anything happens,",
    "so asking beforehand just costs them an extra round trip. Ask only when you genuinely lack a required detail.",
    "Do not claim an action is done until it has actually been confirmed and executed.",
  ].join("\n");
}
