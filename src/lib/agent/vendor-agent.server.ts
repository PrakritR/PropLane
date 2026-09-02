/**
 * Vendor-agent conversation runtime. A session (agent_sessions row, kind
 * 'vendor_work_order') binds one work order + one vendor + one conversation
 * that both channels share: inbound SMS (Twilio webhook) and in-app inbox
 * replies trigger the same turn, and every reply goes back out over both.
 * Reply delivery is code here — never a model-chosen tool.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { formatPacificDateTime } from "@/lib/pacific-time";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { runAgentTurn } from "@/lib/agent/loop";
import { TIER_MODELS } from "@/lib/agent/model";
import { VENDOR_WORK_ORDER_SMS_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { traceAgentTurn, type TraceActor } from "@/lib/observability/langfuse";
import { buildVendorAgentContext } from "@/lib/tools/context";
import { vendorWorkOrderAgentRegistry } from "@/lib/tools";
import { ESCALATE_TOOL_NAME } from "@/lib/tools/domains/vendor-work-order";
import { isPhoneOptedOut, optedOutFromTimestamps } from "@/lib/sms-consent";
import { normalizeE164, sendSms } from "@/lib/twilio";

type Db = SupabaseClient;

const VENDOR_INBOX_SCOPE = "axis_portal_inbox_vendor_v1";
const MAX_INBOUND_PER_HOUR = 20;
const HISTORY_LIMIT = 20;

export type VendorAgentSessionRow = {
  id: string;
  landlord_id: string;
  kind: string;
  vendor_user_id: string | null;
  vendor_directory_id: string | null;
  work_order_id: string | null;
  vendor_phone_e164: string | null;
  status: string;
  inbox_thread_id: string | null;
};

/** ID-only attribution for a job-bound vendor conversation. */
export function vendorWorkOrderTraceActor(
  session: VendorAgentSessionRow,
  channel: "sms" | "inbox",
): TraceActor {
  return {
    userId: session.vendor_user_id ?? session.landlord_id,
    metadata: {
      landlordId: session.landlord_id,
      role: "vendor",
      managerIds: [session.landlord_id],
      channel,
    },
  };
}

const SESSION_COLUMNS =
  "id, landlord_id, kind, vendor_user_id, vendor_directory_id, work_order_id, vendor_phone_e164, status, inbox_thread_id";

export async function findVendorAgentSessionByThread(db: Db, inboxThreadId: string): Promise<VendorAgentSessionRow | null> {
  const { data } = await db
    .from("agent_sessions")
    .select(SESSION_COLUMNS)
    .eq("inbox_thread_id", inboxThreadId)
    .eq("kind", "vendor_work_order")
    .maybeSingle();
  return (data as VendorAgentSessionRow | null) ?? null;
}

/** Newest active-ish session for a phone number — how inbound SMS finds its conversation. */
export async function findVendorAgentSessionByPhone(db: Db, phoneE164: string): Promise<VendorAgentSessionRow | null> {
  const { data } = await db
    .from("agent_sessions")
    .select(SESSION_COLUMNS)
    .eq("kind", "vendor_work_order")
    .eq("vendor_phone_e164", phoneE164)
    .in("status", ["active", "escalated"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as VendorAgentSessionRow | null) ?? null;
}

function shortNow(): string {
  return formatPacificDateTime(new Date());
}

/** Append one message into the session's vendor inbox thread (both directions mirror here). */
async function appendToInboxThread(
  db: Db,
  threadId: string,
  message: { from: string; body: string },
  opts: { unread: boolean },
): Promise<void> {
  const { data: threadRow } = await db
    .from("portal_inbox_thread_records")
    .select("id, scope, owner_user_id, participant_email, thread_type, row_data")
    .eq("id", threadId)
    .maybeSingle();
  if (!threadRow) return;
  const rowData = (threadRow.row_data ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(rowData.messages) ? [...rowData.messages] : [];
  const when = shortNow();
  messages.push({ id: `agent-${Date.now().toString(36)}`, from: message.from, body: message.body, at: when });
  await db.from("portal_inbox_thread_records").upsert(
    {
      id: threadId,
      scope: threadRow.scope,
      owner_user_id: threadRow.owner_user_id,
      participant_email: threadRow.participant_email,
      thread_type: threadRow.thread_type,
      row_data: {
        ...rowData,
        messages,
        preview: message.body.slice(0, 100).replace(/\n/g, " "),
        time: when,
        unread: opts.unread,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

async function vendorSmsState(db: Db, session: VendorAgentSessionRow): Promise<{ optedOut: boolean; consentAt: string | null }> {
  if (!session.vendor_user_id) return { optedOut: false, consentAt: null };
  const { data } = await db
    .from("profiles")
    .select("phone, sms_opt_out_at, sms_consent_at")
    .eq("id", session.vendor_user_id)
    .maybeSingle();
  let optedOut = optedOutFromTimestamps(data?.sms_consent_at, data?.sms_opt_out_at);
  // The unified read (global supersede across the ledger, phone-matched
  // profiles, AND the vendor's own user-keyed row) is AUTHORITATIVE, so this
  // gate always agrees with the send-time choke point — a STOP recorded on
  // either store blocks, and a later cross-store START re-enables — while a
  // legacy user-keyed STOP with an unmatchable phone still counts.
  const phone = String((data?.phone as string | null) ?? "").trim() || session.vendor_phone_e164 || null;
  try {
    optedOut = await isPhoneOptedOut(db, phone ?? "", { userId: session.vendor_user_id });
  } catch {
    /* fail open — same posture as the send-time choke point */
  }
  return { optedOut, consentAt: (data?.sms_consent_at as string | null) ?? null };
}

/** Send the agent's reply out over every channel the session has. Not a model tool.
 * The SMS leg only fires when the vendor is replying to their own text (inherently
 * responsive) or has granted SMS consent — never as an unsolicited push. */
export async function deliverVendorAgentReply(
  db: Db,
  session: VendorAgentSessionRow,
  text: string,
  inboundChannel?: "sms" | "inbox",
): Promise<void> {
  if (session.inbox_thread_id) {
    await appendToInboxThread(db, session.inbox_thread_id, { from: "PropLane Assistant", body: text }, { unread: true });
  }
  const from = process.env.AXIS_AGENT_SMS_FROM?.trim();
  if (!session.vendor_phone_e164 || !from) return;
  const { optedOut, consentAt } = await vendorSmsState(db, session);
  if (optedOut) return;
  if (inboundChannel !== "sms" && !consentAt) return;
  const result = await sendSms(session.vendor_phone_e164, text, from);
  if (!result.sent && result.error) {
    // ponytail: no email fallback for agent replies yet — the inbox copy above
    // is always written; wire sendVendorNotification here if delivery gaps show up.
    console.error("vendor-agent SMS send failed", session.id, result.error);
  }
}

/** Merge consecutive same-role rows and drop a leading assistant run so the
 * history satisfies the API's strict user/assistant alternation. */
export function buildAlternatingHistory(
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

/**
 * Run one vendor-agent turn: persist the inbound message, answer it with the
 * scoped registry, persist + deliver the reply. Returns the reply text, or
 * null when the turn was suppressed (closed session, rate cap).
 */
export async function runVendorAgentSessionTurn(
  db: Db,
  session: VendorAgentSessionRow,
  inboundText: string,
  channel: "sms" | "inbox",
): Promise<string | null> {
  const text = inboundText.trim().slice(0, 2000);
  if (!text) return null;
  if (session.status === "closed") return null;
  if (!session.work_order_id || !session.vendor_directory_id) return null;

  // Per-session hourly cap bounds cost from SMS floods and injection loops.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await db
    .from("agent_messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", session.id)
    .eq("role", "user")
    .gte("created_at", oneHourAgo);
  if ((count ?? 0) >= MAX_INBOUND_PER_HOUR) {
    console.error("vendor-agent turn suppressed: hourly cap", session.id);
    return null;
  }

  const nowIso = new Date().toISOString();
  await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "user",
    content: text,
    channel,
  });
  track("vendor_agent_message_in", session.landlord_id, { work_order_id: session.work_order_id, channel });

  // Inbound SMS mirrors into the shared inbox thread; in-app replies are
  // already in the thread (the send route appended before invoking us).
  if (channel === "sms" && session.inbox_thread_id) {
    await appendToInboxThread(db, session.inbox_thread_id, { from: "Vendor (text message)", body: text }, { unread: false });
  }

  const { data: historyRows } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", session.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = buildAlternatingHistory(((historyRows ?? []) as { role: string; content: string }[]).reverse());
  if (history.length === 0 || history.at(-1)!.role !== "user") {
    history.push({ role: "user", content: text });
  }

  const ctx = buildVendorAgentContext(db, {
    landlordId: session.landlord_id,
    scope: {
      sessionId: session.id,
      vendorDirectoryId: session.vendor_directory_id,
      vendorUserId: session.vendor_user_id,
      workOrderId: session.work_order_id,
    },
  });

  let traceId: string | null = null;
  const result = await traceAgentTurn(
    vendorWorkOrderTraceActor(session, channel),
    history as { role: string; content: string }[],
    (observer) =>
      runAgentTurn({
        ctx,
        registry: vendorWorkOrderAgentRegistry,
        messages: history,
        observer,
        system: VENDOR_WORK_ORDER_SMS_SYSTEM_PROMPT,
        model: { model: TIER_MODELS.standard, tier: "standard" },
        readOnly: true,
        allowWriteTools: [ESCALATE_TOOL_NAME],
      }),
    {
      name: "vendor-agent-turn",
      sessionId: session.id,
      promptMeta: resolvePromptMeta(PROMPT_IDS.vendorSmsAgent, VENDOR_WORK_ORDER_SMS_SYSTEM_PROMPT),
      onTraceId: (id) => {
        traceId = id;
      },
    },
  );

  await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "assistant",
    content: result.reply,
    channel: "agent",
    tool_trace: result.toolTrace,
    trace_id: traceId,
  });
  await db.from("agent_sessions").update({ updated_at: nowIso }).eq("id", session.id);
  track("vendor_agent_message_out", session.landlord_id, {
    work_order_id: session.work_order_id,
    channel,
    tools: result.toolTrace.length,
  });

  await deliverVendorAgentReply(db, session, result.reply, channel);
  return result.reply;
}

/**
 * Create (or refresh) the conversation for a dispatched work order: one session
 * per (work order, vendor), a vendor-owned inbox thread when the vendor has an
 * account, and an opening SMS when a number is on file. Idempotent — safe to
 * call again on re-dispatch.
 */
export async function ensureVendorAgentSession(
  db: Db,
  args: {
    landlordId: string;
    workOrderId: string;
    vendorDirectoryId: string;
    vendorUserId: string | null;
    vendorName: string;
    workOrderTitle: string;
    propertyLabel: string;
  },
): Promise<VendorAgentSessionRow | null> {
  // Phone: vendor's own profile number first, then the manager-entered directory number.
  let rawPhone: string | null = null;
  let optedOut = false;
  // A signed-up vendor must have granted SMS consent before the unsolicited
  // opening text; a pre-signup invitee (no profile yet) was disclosed the
  // job-texts terms in the invite modal, so their number is fair game.
  let consentOk = !args.vendorUserId;
  if (args.vendorUserId) {
    const { data } = await db
      .from("profiles")
      .select("phone, sms_opt_out_at, sms_consent_at")
      .eq("id", args.vendorUserId)
      .maybeSingle();
    rawPhone = String((data?.phone as string | null) ?? "").trim() || null;
    optedOut = optedOutFromTimestamps(data?.sms_consent_at, data?.sms_opt_out_at);
    consentOk = Boolean(data?.sms_consent_at);
  }
  if (!rawPhone) {
    const { data } = await db
      .from("manager_vendor_records")
      .select("row_data")
      .eq("id", args.vendorDirectoryId)
      .maybeSingle();
    rawPhone = ((data?.row_data as { phone?: string } | null)?.phone ?? "").trim() || null;
  }
  const phoneE164 = rawPhone ? normalizeE164(rawPhone) : null;
  // Unified opt-out: the global read (ledger + profile variants + the
  // vendor's own user-keyed row, global supersede) is AUTHORITATIVE, covering
  // the directory-only number, cross-store re-opt-ins, and legacy user-keyed
  // STOPs with an unmatchable phone alike.
  if (phoneE164 || args.vendorUserId) {
    try {
      optedOut = await isPhoneOptedOut(db, phoneE164 ?? "", { userId: args.vendorUserId });
    } catch {
      /* fail open — consistent with the send-time choke point */
    }
  }

  const { data: sessionData, error } = await db
    .from("agent_sessions")
    .upsert(
      {
        landlord_id: args.landlordId,
        user_id: args.vendorUserId,
        kind: "vendor_work_order",
        vendor_user_id: args.vendorUserId,
        vendor_directory_id: args.vendorDirectoryId,
        work_order_id: args.workOrderId,
        vendor_phone_e164: phoneE164,
        status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "work_order_id,vendor_directory_id" },
    )
    .select(SESSION_COLUMNS)
    .single();
  if (error || !sessionData) {
    console.error("ensureVendorAgentSession: session upsert failed", error);
    return null;
  }
  const session = sessionData as VendorAgentSessionRow;

  // Vendor-owned inbox thread (deterministic id — re-dispatch reuses it).
  if (args.vendorUserId && !session.inbox_thread_id) {
    const threadId = `vendor_agent_${args.workOrderId}_${args.vendorDirectoryId}`;
    const opening = [
      `PropLane Assistant here for the job "${args.workOrderTitle}" at ${args.propertyLabel}.`,
      "Ask me any time about the job: entry details, directions, what's wrong, or when the visit is.",
    ].join("\n");
    await db.from("portal_inbox_thread_records").upsert(
      {
        id: threadId,
        scope: VENDOR_INBOX_SCOPE,
        owner_user_id: args.vendorUserId,
        participant_email: null,
        thread_type: "vendor_agent",
        row_data: {
          id: threadId,
          folder: "inbox",
          from: "PropLane Assistant",
          email: "",
          subject: `Job: ${args.workOrderTitle} - ${args.propertyLabel}`,
          preview: opening.slice(0, 100).replace(/\n/g, " "),
          body: opening,
          messages: [{ id: `agent-${Date.now().toString(36)}`, from: "PropLane Assistant", body: opening, at: shortNow() }],
          unread: true,
          scope: VENDOR_INBOX_SCOPE,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    await db.from("agent_sessions").update({ inbox_thread_id: threadId }).eq("id", session.id);
    session.inbox_thread_id = threadId;
  }

  // Opening SMS: transactional job coordination; STOP is honored via the
  // webhook + Twilio Advanced Opt-Out, and we never text an opted-out number.
  const from = process.env.AXIS_AGENT_SMS_FROM?.trim();
  if (phoneE164 && from && !optedOut && consentOk) {
    await sendSms(
      phoneE164,
      `PropLane here about the job "${args.workOrderTitle}" at ${args.propertyLabel}. Reply to this number any time with questions about the job (entry details, directions, timing). Reply STOP to opt out.`,
      from,
    );
  }

  return session;
}
