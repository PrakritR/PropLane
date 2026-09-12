import { readCommsTurnResult, completeCommsTurn, INTERRUPTED_COMMS_REPLY } from "@/lib/comms-billing/turn-result.server";
import { reserveCommsCredit } from "@/lib/comms-billing/wallet.server";
/**
 * Leasing SMS agent runtime. A session (agent_sessions, kind `leasing_sms`)
 * binds one manager (work-number owner) + one prospect phone. Inbound Twilio
 * texts run a Claude turn with listing tools; replies are sent from the
 * manager's work number via code (never a model tool).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { runAgentTurn, type AgentObserver, type ToolCallEvent } from "@/lib/agent/loop";
import { TIER_MODELS } from "@/lib/agent/model";
import { leasingSmsSystemPromptForWorkNumberOwner } from "@/lib/agent/leasing-sms-custom-instructions";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { traceAgentTurn, traceProspectShadowComparison, type TraceActor } from "@/lib/observability/langfuse";
import { buildLeasingSmsAgentContext } from "@/lib/tools/context";
import { leasingSmsAgentRegistry, LEASING_SMS_INLINE_WRITE_TOOLS } from "@/lib/tools";
import { toAnthropicTools } from "@/lib/tools/registry";
import type { ProspectShadowBurst } from "@/lib/agent/prospect-gpt-shadow";
import { projectProspectShadowPrimaryEvidence, prospectRepetitionEvidence } from "@/lib/agent/prospect-shadow-comparison";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { normalizeE164 } from "@/lib/twilio";

type Db = SupabaseClient;

const MAX_INBOUND_PER_HOUR = 30;
const HISTORY_LIMIT = 24;
const SESSION_KIND = "leasing_sms";

async function loadRecentConfirmedReplies(db: Db, args: { landlordId: string; phone: string }) {
  const since = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data } = await db.from("sms_outbox")
    .select("id, body, updated_at")
    .eq("manager_user_id", args.landlordId)
    .eq("recipient_phone", args.phone)
    .eq("counterparty_role", "prospect")
    .in("status", ["submitted", "sent", "delivered"])
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(4);
  return (data ?? []).map((row) => ({
    messageId: String((row as { id?: unknown }).id ?? ""),
    text: String((row as { body?: unknown }).body ?? ""),
    submittedAt: String((row as { updated_at?: unknown }).updated_at ?? ""),
  })).filter((row) => row.messageId && row.text && row.submittedAt);
}

async function loadDurableSmsHistory(db: Db, args: {
  landlordId: string; phone: string; claimedText: string;
  claimedSourceIds: string[]; snapshotCutoff?: string;
}) {
  const conversationKey = buildConversationKey({
    ownerManagerUserId: args.landlordId,
    role: "prospect",
    counterpartyPhone: args.phone,
  });
  const cutoff = args.snapshotCutoff ?? new Date().toISOString();
  const [{ data: inbound }, { data: outbound }] = await Promise.all([
    db.from("manager_sms_messages")
      .select("direction,body,message_sid,created_at")
      .eq("manager_user_id", args.landlordId)
      .eq("conversation_key", conversationKey)
      .eq("direction", "inbound")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
    db.from("sms_outbox")
      .select("body,provider_message_sid,created_at")
      .eq("manager_user_id", args.landlordId)
      .eq("conversation_key", conversationKey)
      .in("status", ["submitted", "sent", "delivered"])
      .lt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);
  const rows = [
    ...((inbound ?? []) as { direction: string; body: string; message_sid?: string | null; created_at: string }[]),
    ...((outbound ?? []) as { body: string; provider_message_sid?: string | null; created_at: string }[]).map((row) => ({
      direction: "outbound",
      body: row.body,
      message_sid: row.provider_message_sid,
      created_at: row.created_at,
    })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-HISTORY_LIMIT);
  return buildDurableSmsHistory(
    rows,
    args,
  );
}

export function buildDurableSmsHistory(
  rows: { direction: string; body: string; message_sid?: string | null; created_at: string }[],
  args: { claimedText: string; claimedSourceIds: string[]; snapshotCutoff?: string },
): Anthropic.MessageParam[] {
  const claimed = new Set(args.claimedSourceIds);
  const cutoff = args.snapshotCutoff ? Date.parse(args.snapshotCutoff) : Number.POSITIVE_INFINITY;
  const prior = rows
    .filter((row) => !Number.isFinite(cutoff) || Date.parse(row.created_at) < cutoff)
    .filter((row) => row.direction === "outbound" || !row.message_sid || !claimed.has(row.message_sid))
    .map((row) => ({ role: row.direction === "outbound" ? "assistant" : "user", content: row.body }));
  return buildAlternatingHistory([...prior, { role: "user", content: args.claimedText }]);
}

async function loadConfirmedToolContext(db: Db, burstId: string): Promise<unknown[]> {
  const { data } = await db.from("prospect_sms_bursts")
    .select("history_snapshot")
    .eq("id", burstId)
    .maybeSingle();
  const value = (data as { history_snapshot?: unknown } | null)?.history_snapshot;
  return Array.isArray(value) ? value.slice(-8) : [];
}

type DurableToolContext = { tool: string; input: unknown; output: unknown; recordedAt: string };

/** Retain canonical identity through no-tool turns; a successful explicit
 * details lookup replaces the old property's facts. Availability remains
 * timestamped and the prompt still requires a live availability tool call. */
export function mergeDurableToolContext(
  previous: unknown[],
  current: { tool: string; input: unknown; output: unknown }[],
  recordedAt: string,
): DurableToolContext[] {
  const successfulFacts = current.filter((item) => {
    if (!item.output || typeof item.output !== "object") return true;
    const output = item.output as { ok?: unknown; found?: unknown };
    return output.ok !== false && output.found !== false;
  });
  const successfulResolution = successfulFacts.some((item) => {
    if (item.tool !== "get_listing_details" || !item.output || typeof item.output !== "object") return false;
    return (item.output as { found?: unknown }).found === true;
  });
  const retained = successfulResolution ? [] : previous.filter((item): item is DurableToolContext => Boolean(item && typeof item === "object"));
  return [...retained, ...successfulFacts.map((item) => ({ ...item, recordedAt }))].slice(-8);
}

/** ID-only Langfuse attribution; prospect phone and message stay out of metadata. */
export function leasingSmsTraceActor(landlordId: string): TraceActor {
  return {
    userId: landlordId,
    metadata: {
      landlordId,
      role: "prospect",
      managerIds: [landlordId],
      channel: "sms",
    },
  };
}

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
    if (last && last.role === role) {
      last.content = `${last.content}\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  while (out[0] && out[0].role === "assistant") out.shift();
  return out;
}

export type LeasingSmsSessionRow = {
  id: string;
  landlord_id: string;
  kind: string;
  vendor_phone_e164: string | null;
  status: string;
};

type LeasingSmsTurn = {
  reply: string;
  suppressed: boolean;
  suppression?: { toolName: string; referenceMessageId: string; reason: string };
  /** A delivered opt-in manager handoff intentionally sends no prospect SMS. */
  disposition?: "quiet_handoff";
  sessionId: string;
  inboundMessageId: string | null;
  assistantMessageId: string | null;
  traceId: string | null;
  candidateContext?: unknown[];
  shadowInput?: ProspectShadowBurst;
};

const SESSION_COLUMNS = "id, landlord_id, kind, vendor_phone_e164, status";

export async function findOrCreateLeasingSmsSession(
  db: Db,
  args: { landlordId: string; prospectPhoneE164: string },
): Promise<LeasingSmsSessionRow | null> {
  const landlordId = args.landlordId.trim();
  const phone = normalizeE164(args.prospectPhoneE164) ?? args.prospectPhoneE164.trim();
  if (!landlordId || !phone) return null;

  const { data: existing } = await db
    .from("agent_sessions")
    .select(SESSION_COLUMNS)
    .eq("kind", SESSION_KIND)
    .eq("landlord_id", landlordId)
    .eq("vendor_phone_e164", phone)
    .maybeSingle();
  if (existing) {
    const row = existing as LeasingSmsSessionRow;
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
      user_id: null,
      kind: SESSION_KIND,
      vendor_phone_e164: phone,
      status: "active",
    })
    .select(SESSION_COLUMNS)
    .maybeSingle();

  if (error) {
    // Race: unique index — re-read.
    if (error.code === "23505") {
      const { data: raced } = await db
        .from("agent_sessions")
        .select(SESSION_COLUMNS)
        .eq("kind", SESSION_KIND)
        .eq("landlord_id", landlordId)
        .eq("vendor_phone_e164", phone)
        .maybeSingle();
      return (raced as LeasingSmsSessionRow | null) ?? null;
    }
    console.error("leasing-sms session create failed", error.message);
    return null;
  }
  return (created as LeasingSmsSessionRow | null) ?? null;
}

/**
 * Run one leasing-SMS turn and return the assistant reply text (caller sends SMS).
 * Returns null when suppressed (rate cap, missing API key, empty body).
 */
export async function runLeasingSmsAgentTurn(
  db: Db,
  args: {
    landlordId: string;
    prospectPhoneE164: string;
    inboundText: string;
    workNumber?: string | null;
    inboundMessageSid?: string | null;
    /** True on the shared Claw line — lets listing tools span the whole public catalog. */
    crossCatalog?: boolean;
    channel?: "sms" | "voice";
    maxReplyChars?: number;
    traceName?: string;
    /** Queue-worker revision lease; absent on voice and legacy synchronous turns. */
    prospectBurst?: { burstId: string; revision: number; workerId: string; claimedSourceIds?: string[]; snapshotCutoff?: string };
  },
): Promise<LeasingSmsTurn | null> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;

  const text = args.inboundText.trim().slice(0, 2000);
  if (!text) return null;

  const session = await findOrCreateLeasingSmsSession(db, {
    landlordId: args.landlordId,
    prospectPhoneE164: args.prospectPhoneE164,
  });
  if (!session) return null;

  const channel = args.channel ?? "sms";
  const maxReplyChars = args.maxReplyChars ?? (channel === "voice" ? 900 : 1500);
  const traceName = args.traceName ?? "leasing-sms-agent-turn";

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db
    .from("agent_messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", session.id)
    .eq("role", "user")
    .gte("created_at", oneHourAgo);
  if ((count ?? 0) >= MAX_INBOUND_PER_HOUR) {
    console.error("leasing-sms turn suppressed: hourly cap", session.id);
    return null;
  }

  const nowIso = new Date().toISOString();
  const sourceMessageSid = args.inboundMessageSid?.trim() || null;
  const { data: insertedInbound, error: inboundError } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "user",
    content: text,
    channel,
    source_message_sid: sourceMessageSid,
  }).select("id").maybeSingle();
  let inboundMessageId = insertedInbound?.id ? String(insertedInbound.id) : null;
  if (inboundError?.code === "23505" && sourceMessageSid) {
    const { data: existingInbound } = await db
      .from("agent_messages")
      .select("id")
      .eq("source_message_sid", sourceMessageSid)
      .eq("role", "user")
      .maybeSingle();
    inboundMessageId = existingInbound?.id ? String(existingInbound.id) : null;
  } else if (inboundError) {
    console.error("leasing-sms inbound message persistence failed", session.id, inboundError.message);
    return null;
  }
  track(channel === "voice" ? "leasing_voice_message_in" : "leasing_sms_message_in", session.landlord_id, {
    channel,
  });

  if (!inboundMessageId) return null;
  const creditKey = `ai_turn:${channel}:${session.id}:${inboundMessageId}`;
  const credit = await reserveCommsCredit(db, { managerUserId: session.landlord_id, meter: "ai_agent_turn",
    idempotencyKey: creditKey, metadata: { sessionId: session.id, channel } });
  if (!credit.allowed) return null;
  if (credit.duplicate) return readCommsTurnResult<LeasingSmsTurn>(db, session.landlord_id, creditKey, {
    reply: INTERRUPTED_COMMS_REPLY,
    suppressed: false,
    sessionId: session.id,
    inboundMessageId,
    assistantMessageId: null,
    traceId: null,
  });
  const execute = async (): Promise<LeasingSmsTurn | null> => {
  let history: Anthropic.MessageParam[];
  if (args.prospectBurst) {
    history = await loadDurableSmsHistory(db, {
      landlordId: session.landlord_id,
      phone: normalizeE164(args.prospectPhoneE164) ?? args.prospectPhoneE164.trim(),
      claimedText: text,
      claimedSourceIds: args.prospectBurst.claimedSourceIds ?? [sourceMessageSid ?? ""].filter(Boolean),
      snapshotCutoff: args.prospectBurst.snapshotCutoff,
    });
  } else {
    const { data: historyRows } = await db
      .from("agent_messages")
      .select("role, content")
      .eq("session_id", session.id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    history = buildAlternatingHistory(
      ((historyRows ?? []) as { role: string; content: string }[]).reverse(),
    ) as Anthropic.MessageParam[];
  }
  if (!args.prospectBurst && (history.length === 0 || history.at(-1)!.role !== "user")) {
    history.push({ role: "user", content: text });
  }

  const prospectPhone =
    normalizeE164(args.prospectPhoneE164) ?? args.prospectPhoneE164.trim();
  const recentDeliveredReplies = await loadRecentConfirmedReplies(db, {
    landlordId: session.landlord_id,
    phone: prospectPhone,
  });
  const ctx = buildLeasingSmsAgentContext(db, {
    landlordId: session.landlord_id,
    scope: {
      sessionId: session.id,
      prospectPhoneE164: prospectPhone,
      workNumber: args.workNumber?.trim() || null,
      crossCatalog: args.crossCatalog === true,
      channel,
      recentDeliveredReplies,
    },
  });

  let result: Awaited<ReturnType<typeof runAgentTurn>> | null = null;
  let traceId: string | null = null;
  let quietHandoffConfirmed = false;
  const observedToolTrace: Array<{ tool: string; ok: boolean }> = [];
  let shadowSystem = "";
  let turnPromptMeta: ReturnType<typeof resolvePromptMeta> | null = null;
  // runAgentTurn appends provider and tool-result rows to its messages array.
  // Preserve this sealed, pre-incumbent input for the isolated shadow.
  const shadowPreTurnConversation = args.prospectBurst ? [...history] : [];
  const confirmedToolContext = args.prospectBurst
    ? await loadConfirmedToolContext(db, args.prospectBurst.burstId)
    : [];
  try {
    // `session.landlord_id` is the manager who owns the sending work number;
    // it is resolved before this function, never supplied by a prospect.
    const systemBase = await leasingSmsSystemPromptForWorkNumberOwner(db, session.landlord_id);
    let system =
      channel === "voice"
        ? `${systemBase}\n\nYou are speaking on a phone call, not texting. Keep replies concise and easy to hear. Always call list_open_tour_slots before quoting tour availability.`
        : systemBase;
    if (recentDeliveredReplies.length > 0) {
      system += `\n\nConfirmed recent delivered SMS replies eligible for suppress_redundant_reply (copy only these ids):\n${recentDeliveredReplies.map((reply) => `- ${reply.messageId} at ${reply.submittedAt}: ${reply.text}`).join("\n")}`;
    }
    if (args.prospectBurst) {
      if (confirmedToolContext.length > 0) {
        system += `\n\nSuccessful tool facts from earlier submitted replies are authoritative conversation context. Reuse canonical listing/property/room ids for follow-up requests unless the prospect explicitly changes the property. Availability facts are timestamped and must be rechecked with list_open_tour_slots before quoting or requesting a time:\n${JSON.stringify(confirmedToolContext)}`;
      }
    }
    shadowSystem = system;
    turnPromptMeta = resolvePromptMeta(PROMPT_IDS.leasingSmsAgent, system);
    let inlineActionAuthorized = false;
    result = await traceAgentTurn(
      {
        ...leasingSmsTraceActor(session.landlord_id),
        metadata: {
          ...leasingSmsTraceActor(session.landlord_id).metadata,
          channel,
          ...(args.prospectBurst
            ? { burstId: args.prospectBurst.burstId, burstRevision: args.prospectBurst.revision }
            : {}),
        },
      },
      history as { role: string; content: string }[],
      async (observer) => {
        const observeToolCall = (event: ToolCallEvent) => {
          observedToolTrace.push({ tool: event.name, ok: event.ok });
          if (
            event.name === "escalate_to_manager" &&
            event.ok &&
            event.output &&
            typeof event.output === "object" &&
            (event.output as { ok?: unknown }).ok === true &&
            (event.output as { quietHandoff?: unknown }).quietHandoff === true
          ) {
            quietHandoffConfirmed = true;
          }
          // Inspect the disposition before forwarding. Even a broken optional
          // observer must not erase a manager handoff the tool already made.
          try {
            observer?.onToolCall?.(event);
          } catch {
            // Observability remains best-effort, matching the shared loop.
          }
        };
        // Keep the Langfuse observer as the source of truth for every loop
        // event. This narrow wrapper only inspects the typed escalation result.
        const forwardingObserver: AgentObserver = {
          ...(observer ?? {}),
          onToolCall: observeToolCall,
        };
        const turn = await runAgentTurn({
          ctx,
          registry: leasingSmsAgentRegistry,
          messages: history,
          observer: forwardingObserver,
          system,
          model: { model: TIER_MODELS.standard, tier: "standard" },
          readOnly: true,
          allowWriteTools: LEASING_SMS_INLINE_WRITE_TOOLS,
          suppressionTools: ["suppress_redundant_reply"],
          authorizeInlineWrite: args.prospectBurst
            ? async (call) => {
                if (inlineActionAuthorized) return false;
                const { data, error } = await db.rpc("authorize_prospect_sms_inline_action", {
                  p_burst_id: args.prospectBurst!.burstId,
                  p_revision: args.prospectBurst!.revision,
                  p_worker_id: args.prospectBurst!.workerId,
                  p_tool_call_id: call.id,
                  p_tool_name: call.name,
                });
                const authorized = !error && data === true;
                if (authorized) inlineActionAuthorized = true;
                return authorized;
              }
            : undefined,
          releaseInlineWrite: args.prospectBurst
            ? async (call) => {
                const { data, error } = await db.rpc("release_prospect_sms_inline_action", {
                  p_burst_id: args.prospectBurst!.burstId,
                  p_revision: args.prospectBurst!.revision,
                  p_worker_id: args.prospectBurst!.workerId,
                  p_tool_call_id: call.id,
                });
                const released = !error && data === true;
                if (released) inlineActionAuthorized = false;
                return released;
              }
            : undefined,
        });
        // The trace wrapper records the actual customer-visible result.
        return channel === "sms" && quietHandoffConfirmed ? { ...turn, reply: "" } : turn;
      },
      {
        name: traceName,
        sessionId: session.id,
        promptMeta: turnPromptMeta,
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
  } catch (e) {
    if (channel === "sms" && quietHandoffConfirmed) {
      // The manager notification already reached the existing durable notice
      // path. A later model generation failure cannot turn that success into a
      // prospect template reply, which would defeat the requested handoff.
      console.error("leasing-sms agent turn ended after delivered quiet handoff", session.id, e);
    } else {
      console.error("leasing-sms agent turn failed", session.id, e);
      return null;
    }
  }

  const quietHandoff = channel === "sms" && quietHandoffConfirmed;
  if (!quietHandoff && result?.terminationReason === "suppressed") {
    // A suppression is an intentional, traceable outcome. Do not let callers
    // reinterpret it as an agent failure and send a template fallback.
    return {
      reply: "",
      suppressed: true as const,
      suppression: result.suppression,
      sessionId: session.id,
      inboundMessageId,
      assistantMessageId: null,
      traceId,
      candidateContext: [],
    };
  }
  const reply = quietHandoff ? "" : result!.reply.trim().slice(0, maxReplyChars);
  if (!reply && !quietHandoff) return null;
  const toolTrace = result?.toolTrace ?? observedToolTrace;

  // A queued candidate is not conversation history. Durable SMS history comes
  // from manager_sms_messages, which is appended only after provider accepts
  // submission. Legacy synchronous and voice turns retain agent_messages.
  let assistantMessageId: string | null = null;
  if (!args.prospectBurst && !quietHandoff) {
    const { data: assistantMessage } = await db.from("agent_messages").insert({
      session_id: session.id,
      landlord_id: session.landlord_id,
      role: "assistant",
      content: reply,
      channel: "agent",
      tool_trace: toolTrace,
      trace_id: traceId,
    }).select("id").maybeSingle();
    assistantMessageId = assistantMessage?.id ? String(assistantMessage.id) : null;
  }
  await db.from("agent_sessions").update({ updated_at: nowIso }).eq("id", session.id).eq("landlord_id", session.landlord_id);
  if (!quietHandoff) {
    track(channel === "voice" ? "leasing_voice_message_out" : "leasing_sms_message_out", session.landlord_id, {
      channel,
      tools: toolTrace.length,
    });
  }

  return {
    reply,
    suppressed: false as const,
    ...(quietHandoff ? { disposition: "quiet_handoff" as const } : {}),
    sessionId: session.id,
    inboundMessageId,
    assistantMessageId,
    traceId,
    candidateContext: mergeDurableToolContext(
      confirmedToolContext,
      (result?.toolEvidence ?? []).filter((item) => item.tool !== "suppress_redundant_reply"),
      nowIso,
    ),
    shadowInput: args.prospectBurst && result ? {
      burstId: args.prospectBurst.burstId,
      burstRevision: args.prospectBurst.revision,
      promptId: turnPromptMeta?.promptId,
      promptHash: turnPromptMeta?.promptHash,
      release: turnPromptMeta?.release,
      primaryProvider: result.provider ?? "anthropic",
      primaryModel: result.model ?? TIER_MODELS.standard,
      primaryOutput: reply,
      primaryEvidence: {
        ...projectProspectShadowPrimaryEvidence(result.toolEvidence.map((item) => ({
          name: item.tool,
          arguments: item.input,
          output: item.output,
        }))),
        toolCalls: result.toolEvidence.map((item) => ({ name: item.tool, arguments: item.input })),
      },
      repetitionEvidence: prospectRepetitionEvidence(
        text,
        recentDeliveredReplies.map((item) => item.text),
      ),
      conversation: shadowPreTurnConversation,
      preTurnConversation: shadowPreTurnConversation,
      system: shadowSystem,
      tools: toAnthropicTools(leasingSmsAgentRegistry, {
        allowWrite: LEASING_SMS_INLINE_WRITE_TOOLS,
        readOnly: true,
      }),
      toolEvidence: result.toolEvidence.map((item) => ({
        name: item.tool,
        arguments: item.input,
        output: item.output,
      })),
      onResult: (metadata) => {
        void traceProspectShadowComparison({
          managerUserId: session.landlord_id,
          burstId: args.prospectBurst!.burstId,
          primaryTraceId: traceId,
          metadata,
        });
      },
    } : undefined,
  };
  };
  return completeCommsTurn(db, session.landlord_id, creditKey, await execute());
}

/** Leasing / prospect voice — shares session history with leasing SMS on the same phone. */
export async function runLeasingVoiceAgentTurn(
  db: Db,
  args: {
    landlordId: string;
    prospectPhoneE164: string;
    inboundText: string;
    workNumber?: string | null;
    inboundCallSid?: string | null;
    crossCatalog?: boolean;
  },
) {
  return runLeasingSmsAgentTurn(db, {
    landlordId: args.landlordId,
    prospectPhoneE164: args.prospectPhoneE164,
    inboundText: args.inboundText,
    workNumber: args.workNumber,
    inboundMessageSid: args.inboundCallSid,
    crossCatalog: args.crossCatalog,
    channel: "voice",
    maxReplyChars: 900,
    traceName: "leasing-voice-agent-turn",
  });
}

/** Send the leasing agent reply from the manager work number (logs to Communication SMS). */
export async function deliverLeasingSmsReply(args: {
  landlordId: string;
  toPhone: string;
  text: string;
  workNumber?: string | null;
  inboundMessageSid?: string | null;
  traceId?: string | null;
  prospectBurst?: { burstId: string; revision: number; workerId: string; candidateContext?: unknown; candidateShadowSnapshot?: unknown };
}): Promise<import("@/lib/proplane-sms-transport.server").PropLaneSmsResult> {
  return sendFromManagerWorkNumber({
    managerUserId: args.landlordId,
    to: args.toPhone,
    text: args.text,
    fromNumber: args.workNumber,
    source: "automated",
    counterpartyRole: "prospect",
    conversationKey: buildConversationKey({
      ownerManagerUserId: args.landlordId,
      role: "prospect",
      counterpartyPhone: args.toPhone,
    }),
    dedupeKey: args.inboundMessageSid?.trim() ? `inbound_reply_${args.inboundMessageSid.trim()}` : null,
    purpose: "manager_conversation",
    actorUserId: args.landlordId,
    traceId: args.traceId,
    prospectBurst: args.prospectBurst,
  });
}
