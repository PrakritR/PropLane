/**
 * Leasing SMS agent runtime. A session (agent_sessions, kind `leasing_sms`)
 * binds one manager (work-number owner) + one prospect phone. Inbound Twilio
 * texts run a Claude turn with listing tools; replies are sent from the
 * manager's work number via code (never a model tool).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { runAgentTurn } from "@/lib/agent/loop";
import { TIER_MODELS } from "@/lib/agent/model";
import { leasingSmsSystemPromptForWorkNumberOwner } from "@/lib/agent/leasing-sms-custom-instructions";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { traceAgentTurn, type TraceActor } from "@/lib/observability/langfuse";
import { buildLeasingSmsAgentContext } from "@/lib/tools/context";
import { leasingSmsAgentRegistry, LEASING_SMS_INLINE_WRITE_TOOLS } from "@/lib/tools";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { normalizeE164 } from "@/lib/twilio";

type Db = SupabaseClient;

const MAX_INBOUND_PER_HOUR = 30;
const HISTORY_LIMIT = 24;
const SESSION_KIND = "leasing_sms";

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
  },
): Promise<{
  reply: string;
  sessionId: string;
  inboundMessageId: string | null;
  assistantMessageId: string | null;
  traceId: string | null;
} | null> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;

  const text = args.inboundText.trim().slice(0, 2000);
  if (!text) return null;

  const session = await findOrCreateLeasingSmsSession(db, {
    landlordId: args.landlordId,
    prospectPhoneE164: args.prospectPhoneE164,
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
    channel: "sms",
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
  track("leasing_sms_message_in", session.landlord_id, { channel: "sms" });

  const { data: historyRows } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", session.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = buildAlternatingHistory(
    ((historyRows ?? []) as { role: string; content: string }[]).reverse(),
  ) as Anthropic.MessageParam[];
  if (history.length === 0 || history.at(-1)!.role !== "user") {
    history.push({ role: "user", content: text });
  }

  const prospectPhone =
    normalizeE164(args.prospectPhoneE164) ?? args.prospectPhoneE164.trim();
  const ctx = buildLeasingSmsAgentContext(db, {
    landlordId: session.landlord_id,
    scope: {
      sessionId: session.id,
      prospectPhoneE164: prospectPhone,
      workNumber: args.workNumber?.trim() || null,
      crossCatalog: args.crossCatalog === true,
    },
  });

  let result;
  let traceId: string | null = null;
  try {
    // `session.landlord_id` is the manager who owns the sending work number;
    // it is resolved before this function, never supplied by a prospect.
    const system = await leasingSmsSystemPromptForWorkNumberOwner(db, session.landlord_id);
    result = await traceAgentTurn(
      leasingSmsTraceActor(session.landlord_id),
      history as { role: string; content: string }[],
      (observer) =>
        runAgentTurn({
          ctx,
          registry: leasingSmsAgentRegistry,
          messages: history,
          observer,
          system,
          model: { model: TIER_MODELS.standard, tier: "standard" },
          readOnly: true,
          allowWriteTools: LEASING_SMS_INLINE_WRITE_TOOLS,
        }),
      {
        name: "leasing-sms-agent-turn",
        sessionId: session.id,
        promptMeta: resolvePromptMeta(PROMPT_IDS.leasingSmsAgent, system),
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
  } catch (e) {
    console.error("leasing-sms agent turn failed", session.id, e);
    return null;
  }

  const reply = result.reply.trim().slice(0, 1500);
  if (!reply) return null;

  const { data: assistantMessage } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "assistant",
    content: reply,
    channel: "agent",
    tool_trace: result.toolTrace,
    trace_id: traceId,
  }).select("id").maybeSingle();
  await db.from("agent_sessions").update({ updated_at: nowIso }).eq("id", session.id);
  track("leasing_sms_message_out", session.landlord_id, {
    channel: "sms",
    tools: result.toolTrace.length,
  });

  return {
    reply,
    sessionId: session.id,
    inboundMessageId,
    assistantMessageId: assistantMessage?.id ? String(assistantMessage.id) : null,
    traceId,
  };
}

/** Send the leasing agent reply from the manager work number (logs to Communication SMS). */
export async function deliverLeasingSmsReply(args: {
  landlordId: string;
  toPhone: string;
  text: string;
  workNumber?: string | null;
  inboundMessageSid?: string | null;
  traceId?: string | null;
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
  });
}
