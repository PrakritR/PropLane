/**
 * The SMS agent turn: one inbound text becomes one outbound reply, with a
 * portal's tool catalog behind it and the write gate intact.
 *
 * Both texting surfaces that carry a real tool catalog (resident and manager)
 * run this exact body. It was factored out of `resident-sms-agent.server.ts`
 * when the manager surface was added: a second copy of the session/history/
 * proposal machinery is precisely the "two half-wired frameworks" failure
 * AGENTS.md warns about, and the security-relevant halves (one open proposal at
 * a time, confirmation before the model, portal-bound confirm gate) must never
 * be able to drift between surfaces.
 *
 * Invariants this file owns, for every surface:
 *  - Identity is handed IN, never resolved here. A caller that builds `ctx` from
 *    anything the inbound message carried has already lost.
 *  - Writes are NOT allow-listed for inline execution (beyond a surface's own
 *    tiny `allowWriteTools`). The loop proposes, the caller texts the preview,
 *    and the person's reply confirms it.
 *  - A confirmation reply short-circuits the model entirely: "YES" is an
 *    authorization, not a prompt, and must never be re-interpreted by an LLM.
 *  - At most ONE open proposal per actor+session, so a bare "YES" is unambiguous
 *    by construction rather than by guessing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "@/lib/agent/loop";
import type { ActionPreview, ToolRegistry } from "@/lib/tools/registry";
import {
  createPendingActionForUser,
  type AgentPortal,
  type PendingActionActor,
} from "@/lib/tools/pending-actions";
import { decidePendingAction } from "@/lib/agent/pending-action-decision";
import { resolvePromptMeta, type PromptId } from "@/lib/agent/prompt-metadata";
import { loadAgentCustomInstructions, withAgentCustomInstructions } from "@/lib/agent/user-preferences";
import { traceAgentTurn, type TraceActor } from "@/lib/observability/langfuse";
import { track } from "@/lib/analytics/posthog";
import {
  classifySmsConfirmationReply,
  renderPreviewForSms,
  resolveOpenSmsProposal,
  supersedeOpenSmsProposals,
  SMS_PENDING_ACTION_TTL_MS,
} from "@/lib/sms/agent-confirmation.server";
import { recordCommsAgentTurnUsage } from "@/lib/comms-billing/agent-usage.server";

type Db = SupabaseClient;

const SESSION_COLUMNS = "id, landlord_id, kind, vendor_phone_e164, status, user_id";
const HISTORY_LIMIT = 24;
const MAX_INBOUND_PER_HOUR = 30;
/** Texts are read on a phone; keep replies inside a couple of segments. */
const DEFAULT_MAX_REPLY_CHARS = 1200;

async function billSmsAgentTurn(
  db: Db,
  landlordId: string,
  sessionId: string,
  assistantMessageId: string | null,
): Promise<void> {
  if (!assistantMessageId) return;
  await recordCommsAgentTurnUsage(db, {
    managerUserId: landlordId,
    idempotencyKey: `ai_sms:${sessionId}:${assistantMessageId}`,
    channel: "sms",
    metadata: { sessionId, assistantMessageId },
  });
}

export type SmsAgentSessionRow = {
  id: string;
  landlord_id: string;
  kind: string;
  vendor_phone_e164: string | null;
  status: string;
  user_id: string | null;
};

/**
 * The minimum every portal context already satisfies, and exactly what the
 * shared confirm gate (`decidePendingAction`) requires.
 */
export type SmsAgentActor = PendingActionActor & { landlordId: string };

export type SmsAgentTurn = {
  reply: string;
  sessionId: string;
  inboundMessageId?: string | null;
  assistantMessageId?: string | null;
  pendingActionId?: string | null;
  traceId?: string | null;
  /** Set when this turn ended by texting a write proposal awaiting YES/NO. */
  awaitingConfirmation?: boolean;
};

/** Static, per-surface configuration. One object per texting surface. */
export type SmsAgentSurface = {
  /** `agent_sessions.kind`. Needs its own partial unique index migration. */
  sessionKind: string;
  /** Which portal's registry + context resolver owns a proposal from here. */
  portal: AgentPortal;
  /** Base system prompt; personal custom instructions are appended per turn. */
  basePrompt: string;
  promptId: PromptId;
  /** Langfuse trace name, e.g. "resident-sms-agent-turn". */
  traceName: string;
  /** PostHog event names. Reuse an existing name before inventing one. */
  analytics: { messageIn: string; messageOut: string; actionProposed: string };
  /** Write tools this surface may run inline, without a texted confirmation. */
  allowWriteTools?: readonly string[];
  maxReplyChars?: number;
  /** Analytics + persistence channel label. */
  messageChannel?: "sms" | "voice";
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
 * The session is keyed on kind + owning landlord + actor user id + phone.
 *
 * The user id is load-bearing, not decoration: a phone number can change hands,
 * so a phone later verified by a different person must never inherit the prior
 * person's agent session and prompt history. One resident renting from two
 * managers likewise holds two conversations.
 */
export async function findOrCreateSmsAgentSession(
  db: Db,
  args: { kind: string; landlordId: string; actorUserId: string; phoneE164: string },
): Promise<SmsAgentSessionRow | null> {
  const landlordId = args.landlordId.trim();
  const phone = args.phoneE164.trim();
  const actorUserId = args.actorUserId.trim();
  if (!landlordId || !phone || !actorUserId) return null;

  const { data: existing } = await db
    .from("agent_sessions")
    .select(SESSION_COLUMNS)
    .eq("kind", args.kind)
    .eq("landlord_id", landlordId)
    .eq("user_id", actorUserId)
    .eq("vendor_phone_e164", phone)
    .maybeSingle();
  if (existing) {
    const row = existing as SmsAgentSessionRow;
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
      user_id: actorUserId,
      kind: args.kind,
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
        .eq("kind", args.kind)
        .eq("landlord_id", landlordId)
        .eq("user_id", actorUserId)
        .eq("vendor_phone_e164", phone)
        .maybeSingle();
      return (raced as SmsAgentSessionRow | null) ?? null;
    }
    console.error(`${args.kind} session create failed`, error.message);
    return null;
  }
  return (created as SmsAgentSessionRow | null) ?? null;
}

async function recordAssistantReply(
  db: Db,
  session: SmsAgentSessionRow,
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
async function handleConfirmationReply<Ctx extends SmsAgentActor>(
  db: Db,
  args: {
    ctx: Ctx;
    session: SmsAgentSessionRow;
    body: string;
    registry: ToolRegistry<Ctx>;
    surface: SmsAgentSurface;
    traceMetadata: Record<string, unknown>;
    maxReplyChars: number;
  },
): Promise<SmsAgentTurn | null> {
  const { ctx, session, surface } = args;
  const intent = classifySmsConfirmationReply(args.body);
  if (intent === "none") return null;

  const open = await resolveOpenSmsProposal(db, {
    userId: ctx.userId,
    portal: surface.portal,
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
      registry: args.registry,
      portal: surface.portal,
      traceMetadata: args.traceMetadata,
    });
    const reply = decision.kind === "denied" && decision.known
      ? "No problem, I have cancelled that. Anything else?"
      : "I could not cancel that just now. Please try again.";
    const assistantMessageId = await recordAssistantReply(db, session, reply);
    await billSmsAgentTurn(db, ctx.landlordId, session.id, assistantMessageId);
    return { reply, sessionId: session.id, assistantMessageId, pendingActionId: open.actionId };
  }

  // One executor for every surface: it re-checks the portal, re-validates the
  // STORED input against the tool's current schema, and scores the decision.
  const decision = await decidePendingAction({
    action: { kind: "confirm", actionId: open.actionId },
    ctx,
    registry: args.registry,
    portal: surface.portal,
    traceMetadata: args.traceMetadata,
  });
  const executed = decision.kind === "confirmed"
    ? decision.result
    : { ok: false as const, status: 410, error: "That request is no longer available." };
  const reply = executed.ok
    ? [executed.reply, executed.checkoutUrl].filter(Boolean).join("\n\n").slice(0, args.maxReplyChars)
    : executed.error;
  const assistantMessageId = await recordAssistantReply(db, session, reply);
  await billSmsAgentTurn(db, ctx.landlordId, session.id, assistantMessageId);
  return { reply, sessionId: session.id, assistantMessageId, pendingActionId: open.actionId };
}

/**
 * Run one SMS agent turn. Returns null when suppressed (no API key, empty body,
 * hourly cap) so the caller can stay silent rather than send filler.
 *
 * `ctx` MUST come from that surface's own identity resolver. Passing a context
 * built any other way hands the portal's tool catalog to an unverified texter.
 */
export async function runSmsAgentTurn<Ctx extends SmsAgentActor>(
  db: Db,
  args: {
    ctx: Ctx;
    surface: SmsAgentSurface;
    registry: ToolRegistry<Ctx>;
    /** `agent_sessions.landlord_id` — the manager whose work number was texted. */
    sessionLandlordId: string;
    phoneE164: string;
    inboundText: string;
    inboundMessageSid?: string | null;
    /** Optional deterministic response for a scoped lookup miss/ambiguity. */
    precomputedReply?: string | null;
    /** Tool-grounded context resolved before intent classification. */
    additionalSystemContext?: string | null;
    traceActor: TraceActor;
    /** Langfuse metadata for confirm/deny decisions; the session id is merged in. */
    traceMetadata: Record<string, unknown>;
    renderActionPreview?: (preview: ActionPreview) => string;
  },
): Promise<SmsAgentTurn | null> {
  if (!process.env.ANTHROPIC_API_KEY?.trim() && !args.precomputedReply?.trim()) return null;
  const text = args.inboundText.trim().slice(0, 2000);
  if (!text) return null;

  const { ctx, surface, registry } = args;
  const maxReplyChars = surface.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS;
  const messageChannel = surface.messageChannel ?? "sms";
  const renderPreview = args.renderActionPreview ?? renderPreviewForSms;

  const session = await findOrCreateSmsAgentSession(db, {
    kind: surface.sessionKind,
    landlordId: args.sessionLandlordId,
    actorUserId: ctx.userId,
    phoneE164: args.phoneE164,
  });
  if (!session) return null;
  const traceMetadata = { ...args.traceMetadata, sessionId: session.id };

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db
    .from("agent_messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", session.id)
    .eq("role", "user")
    .gte("created_at", oneHourAgo);
  if ((count ?? 0) >= MAX_INBOUND_PER_HOUR) {
    console.error(`${surface.sessionKind} turn suppressed: hourly cap`, session.id);
    return null;
  }

  const inboundMessageSid = args.inboundMessageSid?.trim() || null;
  const { data: insertedInbound, error: inboundInsertError } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "user",
    content: text,
    channel: messageChannel,
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
    console.error(`${surface.sessionKind} inbound message persistence failed`, session.id, inboundInsertError.message);
    return null;
  }
  track(surface.analytics.messageIn, ctx.userId, { channel: messageChannel });

  const confirmation = await handleConfirmationReply(db, {
    ctx,
    session,
    body: text,
    registry,
    surface,
    traceMetadata,
    maxReplyChars,
  });
  if (confirmation) return { ...confirmation, inboundMessageId };

  const precomputedReply = args.precomputedReply?.trim().slice(0, maxReplyChars);
  if (precomputedReply) {
    const assistantMessageId = await recordAssistantReply(db, session, precomputedReply, [], null);
    track(surface.analytics.messageOut, ctx.userId, { channel: messageChannel, tools: 0 });
    await billSmsAgentTurn(db, ctx.landlordId, session.id, assistantMessageId);
    return { reply: precomputedReply, sessionId: session.id, inboundMessageId, assistantMessageId };
  }

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
    const customInstructions = await loadAgentCustomInstructions(db, ctx.userId);
    const system = withAgentCustomInstructions(
      [surface.basePrompt, args.additionalSystemContext?.trim()].filter(Boolean).join("\n\n"),
      customInstructions,
    );
    result = await traceAgentTurn(
      args.traceActor,
      history as { role: string; content: string }[],
      (observer) =>
        runAgentTurn<Ctx>({
          ctx,
          registry,
          messages: history,
          observer,
          system,
          // Writes stay un-allow-listed on purpose: the loop proposes, the
          // person confirms by text. Nothing here executes inline beyond the
          // surface's own tiny allowlist.
          readOnly: false,
          allowWriteTools: surface.allowWriteTools,
        }),
      {
        name: surface.traceName,
        sessionId: session.id,
        promptMeta: resolvePromptMeta(surface.promptId, system),
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
  } catch (e) {
    console.error(`${surface.sessionKind} agent turn failed`, session.id, e);
    return null;
  }

  if (result.pendingAction) {
    // One open proposal at a time, so a later bare "YES" is unambiguous.
    const cleared = await supersedeOpenSmsProposals(db, {
      userId: ctx.userId,
      portal: surface.portal,
      sessionId: session.id,
    });
    if (!cleared.ok) {
      return {
        reply: "I could not set that up just now. Please try again in a moment.",
        sessionId: session.id,
      };
    }
    const actionId = await createPendingActionForUser(db, {
      landlordId: ctx.landlordId,
      userId: ctx.userId,
      toolName: result.pendingAction.toolName,
      input: result.pendingAction.input,
      preview: result.pendingAction.preview,
      portal: surface.portal,
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
    const reply = [result.reply.trim(), renderPreview(result.pendingAction.preview)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, maxReplyChars);
    const assistantMessageId = await recordAssistantReply(db, session, reply, result.toolTrace, traceId);
    track(surface.analytics.actionProposed, ctx.userId, {
      channel: messageChannel,
      tool: result.pendingAction.toolName,
    });
    await billSmsAgentTurn(db, ctx.landlordId, session.id, assistantMessageId);
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

  const reply = result.reply.trim().slice(0, maxReplyChars);
  if (!reply) return null;
  const assistantMessageId = await recordAssistantReply(db, session, reply, result.toolTrace, traceId);
  track(surface.analytics.messageOut, ctx.userId, {
    channel: messageChannel,
    tools: result.toolTrace.length,
  });
  await billSmsAgentTurn(db, ctx.landlordId, session.id, assistantMessageId);
  return { reply, sessionId: session.id, inboundMessageId, assistantMessageId, traceId };
}
