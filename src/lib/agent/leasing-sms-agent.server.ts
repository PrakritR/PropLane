import { smsTaskModel } from "@/lib/agent/runtime-model";
import { hasAgentModelCredential } from "@/lib/agent/model";
import { readCommsTurnResult, completeCommsTurn, commsTurnKey, INTERRUPTED_COMMS_REPLY } from "@/lib/comms-billing/turn-result.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { loadLeadHandoffPrompt } from "@/lib/one-number/lead-handoff-context.server";
import { workspaceOwnedBy } from "@/lib/one-number/shared-line-number.server";
import { finishCommsCredit, reserveCommsCredit, resolveWorkspaceIdForWorkNumber } from "@/lib/comms-billing/wallet.server";
import { isCommsCreditPoolEnabled } from "@/lib/comms-billing/rates";
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
import { LEASING_SMS_STAY_PROMPT } from "@/lib/agent/leasing-sms-stay-prompt";
import { leasingSmsAgentRegistry, leasingSmsAutonomousTourRegistry, LEASING_SMS_AUTONOMOUS_TOUR_WRITE_TOOLS, LEASING_SMS_INLINE_WRITE_TOOLS, LEASING_SMS_STAY_WRITE_TOOLS, withLeasingSmsStayTools } from "@/lib/tools";
import { leasingSendMyLinkTool, withSharedLineTools } from "@/lib/tools/domains/one-number-links";
import { leasingSendListingPhotosTool } from "@/lib/tools/domains/one-number-photos";
import { toAnthropicTools } from "@/lib/tools/registry";
import { isProspectGptShadowEnabled, type ProspectShadowBurst } from "@/lib/agent/prospect-gpt-shadow";
import { projectProspectShadowPrimaryEvidence, prospectRepetitionEvidence } from "@/lib/agent/prospect-shadow-comparison";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { recordAutoReplyOnSmsNoticeFresh } from "@/lib/sms-inbox-notice.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { normalizeE164 } from "@/lib/twilio";
import { currentSmsTestTransport } from "@/lib/sms/sms-test-transport.server";
import {
  loadProspectTourSchedulingContext,
  persistProspectTourSchedulingContext,
  schedulingContextPrompt,
} from "@/lib/prospect-tour-scheduling-context.server";
import { stripLongDashes } from "@/lib/agent/conversation-style-rules";
import { summarizeLeasingEvidence } from "@/lib/agent/leasing-sms-fallback";
import { proplaneSiteLinks, publicOrigin } from "@/lib/tools/domains/leasing-sms";
import { isPropLaneServiceLine } from "@/lib/service/service-catalog.server";

type Db = SupabaseClient;

const MAX_INBOUND_PER_HOUR = 30;
const HISTORY_LIMIT = 24;
const SESSION_KIND = "leasing_sms";

/**
 * A delivered message can suppress an acknowledgment only when the trusted
 * inbound event happened after that delivery. Queue insertion time is not an
 * inbound event clock, so callers must provide the original occurrence time.
 */
export async function loadRecentDeliveredReplies(
  db: Db,
  args: { landlordId: string; phone: string; originalInboundOccurredAt?: string },
) {
  const inboundTime = Date.parse(args.originalInboundOccurredAt ?? "");
  // A missing or malformed original receipt cannot prove ordering. Do not let
  // a worker-start or ingress timestamp turn that uncertainty into silence.
  if (!Number.isFinite(inboundTime)) return [];
  const since = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data } = await db.from("sms_outbox")
    .select("id, body, updated_at")
    .eq("manager_user_id", args.landlordId)
    .eq("recipient_phone", args.phone)
    .eq("counterparty_role", "prospect")
    .eq("status", "delivered")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(8);
  return (data ?? []).map((row) => ({
    messageId: String((row as { id?: unknown }).id ?? ""),
    text: String((row as { body?: unknown }).body ?? ""),
    deliveredAt: String((row as { updated_at?: unknown }).updated_at ?? ""),
  })).filter((row) => row.messageId && row.text && row.deliveredAt &&
    Number.isFinite(Date.parse(row.deliveredAt)) && Date.parse(row.deliveredAt) <= inboundTime,
  ).slice(0, 4);
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
  toolTrace?: { tool: string; ok: boolean }[];
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
  if (!landlordId || !phone) {
    console.warn("leasing-sms session skipped: missing manager or phone", { hasLandlord: Boolean(landlordId) });
    return null;
  }

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
      if (!raced) console.warn("leasing-sms session create raced but re-read found nothing", { landlordId });
      return (raced as LeasingSmsSessionRow | null) ?? null;
    }
    console.error("leasing-sms session create failed", error.message);
    return null;
  }
  return (created as LeasingSmsSessionRow | null) ?? null;
}

/** Authenticated test prospects are bound to an actor + manager + selected listing, never a phone. */
export async function findOrCreateLeasingSmsTestSession(
  db: Db,
  args: { landlordId: string; actorUserId: string; targetListingId: string; sessionKind: string; sessionId?: string | null },
): Promise<LeasingSmsSessionRow | null> {
  const landlordId = args.landlordId.trim();
  const actorUserId = args.actorUserId.trim();
  const sessionKind = args.sessionKind.trim();
  const targetListingId = args.targetListingId.trim();
  if (!landlordId || !actorUserId || !targetListingId || sessionKind !== `leasing_sms_test:${landlordId}:${targetListingId}`) return null;
  const sessionId = args.sessionId?.trim() || null;
  if (sessionId) {
    const { data, error } = await db.from("agent_sessions").select(SESSION_COLUMNS)
      .eq("id", sessionId)
      .eq("kind", sessionKind)
      .eq("landlord_id", landlordId)
      .eq("user_id", actorUserId)
      .eq("test_actor_user_id", actorUserId)
      .eq("sms_test_manager_user_id", landlordId)
      .eq("sms_test_mode", "prospect")
      .eq("sms_test_target_listing_id", targetListingId)
      .eq("status", "active")
      .is("vendor_phone_e164", null)
      .maybeSingle();
    return error ? null : (data as LeasingSmsSessionRow | null);
  }
  const { data: created, error } = await db.from("agent_sessions").insert({
    landlord_id: landlordId,
    user_id: actorUserId,
    kind: sessionKind,
    vendor_phone_e164: null,
    status: "active",
    test_actor_user_id: actorUserId,
    sms_test_manager_user_id: landlordId,
    sms_test_mode: "prospect",
    sms_test_target_listing_id: targetListingId,
    portal: "resident",
  }).select(SESSION_COLUMNS).maybeSingle();
  if (error) return null;
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
    prospectPhoneE164?: string;
    inboundText: string;
    workNumber?: string | null;
    /**
     * The workspace the shared-line router stamped on this text. The shared number has no
     * `manager_sms_numbers` row to place it by, so without this a billed turn on the shared line was
     * refused as "workspace unknown". Re-checked against `landlordId` below; never trusted as given.
     */
    workspaceId?: string | null;
    inboundMessageSid?: string | null;
    /** True on the shared Claw line — lets listing tools span the whole public catalog. */
    crossCatalog?: boolean;
    channel?: "sms" | "voice";
    maxReplyChars?: number;
    traceName?: string;
    /** Queue-worker revision lease; absent on voice and legacy synchronous turns. */
    prospectBurst?: {
      burstId: string; revision: number; workerId: string; claimedSourceIds?: string[];
      snapshotCutoff?: string;
      /** Earliest trusted event time in this burst; never an ingress insertion time. */
      originalInboundOccurredAt?: string;
      testSessionId?: string;
    };
    /** Authenticated test identity. It is deliberately never coerced into a phone field. */
    testActor?: { userId: string; email: string; targetListingId: string; sessionKind: string; sessionId?: string | null };
    testTarget?: { listingId: string; title: string };
  },
): Promise<LeasingSmsTurn | null> {
  if (!hasAgentModelCredential(smsTaskModel(args.landlordId, args.channel))) {
    console.warn("leasing-sms turn skipped: selected model credential missing");
    return null;
  }

  const text = args.inboundText.trim().slice(0, 2000);
  if (!text) {
    console.warn("leasing-sms turn skipped: empty inbound text", { landlordId: args.landlordId });
    return null;
  }

  const session = args.testActor
    ? await findOrCreateLeasingSmsTestSession(db, {
        landlordId: args.landlordId,
        actorUserId: args.testActor.userId,
        targetListingId: args.testActor.targetListingId,
        sessionKind: args.testActor.sessionKind,
        sessionId: args.testActor.sessionId,
      })
    : await findOrCreateLeasingSmsSession(db, {
        landlordId: args.landlordId,
        prospectPhoneE164: args.prospectPhoneE164 ?? "",
      });
  if (!session) {
    console.warn("leasing-sms turn skipped: no session", { landlordId: args.landlordId });
    return null;
  }

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

  if (!inboundMessageId) {
    console.warn("leasing-sms turn skipped: inbound message id unavailable", session.id);
    return null;
  }
  let toolsRan = false;
  const execute = async (): Promise<LeasingSmsTurn | null> => {
  let history: Anthropic.MessageParam[];
  if (args.prospectBurst && !args.testActor) {
    history = await loadDurableSmsHistory(db, {
      landlordId: session.landlord_id,
      phone: normalizeE164(args.prospectPhoneE164 ?? "") ?? (args.prospectPhoneE164 ?? "").trim(),
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
  if ((!args.prospectBurst || args.testActor) && (history.length === 0 || history.at(-1)!.role !== "user")) {
    history.push({ role: "user", content: text });
  }

  const prospectPhone = normalizeE164(args.prospectPhoneE164 ?? "") ?? (args.prospectPhoneE164 ?? "").trim();
  // The PropLane line in per-workspace mode (a number the platform service owner holds): the catalog is the homes PropLane
  // manages, not this account's own other workspaces. Any other number keeps its workspace's homes only.
  const serviceLine = !args.testActor && args.crossCatalog !== true && channel === "sms"
    ? await isPropLaneServiceLine(db, { ownerUserId: session.landlord_id, workNumber: args.workNumber })
    : false;
  const recentDeliveredReplies = args.testActor ? [] : await loadRecentDeliveredReplies(db, {
    landlordId: session.landlord_id,
    phone: prospectPhone,
    originalInboundOccurredAt: args.prospectBurst?.originalInboundOccurredAt,
  });
  const ctx = buildLeasingSmsAgentContext(db, {
    landlordId: session.landlord_id,
    actorUserId: args.testActor?.userId,
    scope: {
      sessionId: session.id,
      prospectPhoneE164: prospectPhone,
      ...(args.testActor ? {
        testActorUserId: args.testActor.userId,
        testSessionId: args.testActor.sessionId ?? args.prospectBurst?.testSessionId ?? session.id,
      } : {}),
      prospectEmail: args.testActor?.email ?? null,
      workNumber: args.workNumber?.trim() || null,
      crossCatalog: args.crossCatalog === true,
      ...(serviceLine ? { serviceCatalog: true } : {}),
      channel,
      currentInboundText: text,
      recentDeliveredReplies,
      prospectBurst: args.prospectBurst
        ? {
            burstId: args.prospectBurst.burstId,
            revision: args.prospectBurst.revision,
            workerId: args.prospectBurst.workerId,
            claimedSourceIds: args.prospectBurst.claimedSourceIds ?? [],
          }
        : undefined,
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
  const conversationKey = buildConversationKey({
    ownerManagerUserId: session.landlord_id,
    role: "prospect",
    ...(args.testActor
      ? { counterpartyUserId: args.testActor.sessionId ?? args.prospectBurst?.testSessionId ?? session.id }
      : { counterpartyPhone: prospectPhone }),
  });
  const durableSchedulingContext = args.prospectBurst
    ? await loadProspectTourSchedulingContext(db, { managerUserId: session.landlord_id, conversationKey })
    : null;
  try {
    // `session.landlord_id` is the manager who owns the sending work number;
    // it is resolved before this function, never supplied by a prospect.
    const systemBase = await leasingSmsSystemPromptForWorkNumberOwner(db, session.landlord_id);
    let system =
      channel === "voice"
        ? `${systemBase}\n\nYou are speaking on a phone call, not texting. Keep replies concise and easy to hear. Always call list_open_tour_slots before quoting tour availability.`
        : systemBase;
    if (recentDeliveredReplies.length > 0) {
      system += `\n\nConfirmed recent delivered SMS replies eligible for suppress_redundant_reply (copy only these ids):\n${recentDeliveredReplies.map((reply) => `- ${reply.messageId} at ${reply.deliveredAt}: ${reply.text}`).join("\n")}`;
    }
    if (args.prospectBurst) {
      const persistedSchedulingPrompt = schedulingContextPrompt(durableSchedulingContext);
      if (persistedSchedulingPrompt) {
        system += `\n\nDurable tour-scheduling context from prior submitted turns: ${persistedSchedulingPrompt}`;
      }
      if (confirmedToolContext.length > 0) {
        system += `\n\nSuccessful tool facts from earlier submitted replies are authoritative conversation context. Reuse canonical listing/property/room ids for follow-up requests unless the prospect explicitly changes the property. Availability facts are timestamped and must be rechecked with list_open_tour_slots before quoting or requesting a time:\n${JSON.stringify(confirmedToolContext)}`;
      }
    }
    // The model has no clock: without today's date "Thursday" or "tomorrow" cannot become the fromDate/toDate that
    // list_open_tour_slots needs, and a page of the first 40 slots never reaches the day they asked about.
    system += `\n\nToday in Pacific time is ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date())} (${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())}).`;
    // A prospect who picked a home on the shared line arrives with it already chosen: say so, or the agent asks "which place?".
    if (!args.testActor && channel === "sms") {
      const handoff = await loadLeadHandoffPrompt(db, { ownerUserId: session.landlord_id, workspaceId: args.workspaceId, phone: prospectPhone }).catch(() => null);
      if (handoff) system += `\n\n${handoff}`;
    }
    if (args.testActor && args.testTarget) {
      system += `\n\nThis authenticated test conversation is scoped to the selected listing ${JSON.stringify(args.testTarget.title)} (canonical property id ${JSON.stringify(args.testTarget.listingId)}). Resolve and reuse that listing unless the person explicitly asks to discuss another listing owned by this manager.`;
    }
    if (serviceLine) {
      system += `\n\nYou are answering on the PropLane line. The only homes you know are the ones list_live_listings returns: homes PropLane manages. Never name or suggest a home a tool did not return. For any place the prospect names (a campus, a landmark, a neighborhood, a zip, "near downtown"), call list_live_listings ONCE with area set to their words, then answer from that one result: list up to three homes with name, rent and the distance the tool gave, and put each home's own listingUrl from the tool next to it. Use the tool's browseUrl for "see everything". If the tool says no home is in the area, say so and give the closest ones it returned. If the lookup fails, say a teammate will follow up. When they pick a home, call build_prospect_links and send the tour or apply link.`;
    }
    if (channel === "sms" && !args.testActor) system += `\n\n${LEASING_SMS_STAY_PROMPT}`;
    shadowSystem = system;
    turnPromptMeta = resolvePromptMeta(PROMPT_IDS.leasingSmsAgent, system);
    let inlineActionAuthorized = false;
    result = await traceAgentTurn(
      {
        ...leasingSmsTraceActor(session.landlord_id),
        userId: args.testActor?.userId ?? session.landlord_id,
        metadata: {
          ...leasingSmsTraceActor(session.landlord_id).metadata,
          channel,
          ...(args.prospectBurst
            ? { burstId: args.prospectBurst.burstId, burstRevision: args.prospectBurst.revision }
            : {}),
          ...(args.testActor ? {
            smsTest: true,
            testActorUserId: args.testActor.userId,
            testWorkspace: true,
            testWorkspaceId: currentSmsTestTransport()?.workspaceId ?? null,
          } : {}),
        },
      },
      history as { role: string; content: string }[],
      async (observer) => {
        const observeToolCall = (event: ToolCallEvent) => {
          observedToolTrace.push({ tool: event.name, ok: event.ok });
          toolsRan = true;
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
          registry: await (async () => {
            const base = args.prospectBurst && channel === "sms" ? leasingSmsAutonomousTourRegistry : leasingSmsAgentRegistry;
            // "send me the application" and "send me photos" exist only while the line is shared (one-number build).
            return channel === "sms" ? withSharedLineTools(ctx.db, args.testActor ? base : withLeasingSmsStayTools(base), [leasingSendMyLinkTool, leasingSendListingPhotosTool]) : base;
          })(),
          messages: history,
          observer: forwardingObserver,
          system,
          model: smsTaskModel(session.landlord_id, channel),
          readOnly: true,
          allowWriteTools: [
            ...(args.prospectBurst && channel === "sms" ? LEASING_SMS_AUTONOMOUS_TOUR_WRITE_TOOLS : LEASING_SMS_INLINE_WRITE_TOOLS),
            ...(channel === "sms" && !args.testActor ? LEASING_SMS_STAY_WRITE_TOOLS : []),
          ],
          suppressionTools: ["suppress_redundant_reply"],
          // A prospect never receives the portal's "I can't verify that link" sentence: a link no lookup returned is redone
          // once without links, then answered from the tool results alone. The site links are constants, so always allowed.
          ...(channel === "sms"
            ? {
                linkRecovery: {
                  allowedUrls: Object.values(proplaneSiteLinks(publicOrigin())).filter((value) => value.startsWith("http")),
                  summarize: summarizeLeasingEvidence,
                  replaceWhen: (trace: { tool: string; ok: boolean }[]) => {
                    if (!serviceLine) return false;
                    const lists = trace.filter((entry) => entry.tool === "list_live_listings");
                    return lists.length > 0 && !lists[lists.length - 1].ok;
                  },
                },
              }
            : {}),
          authorizeInlineWrite: args.prospectBurst
            ? async (call) => {
                if (inlineActionAuthorized) return false;
                const { data, error } = await db.rpc(
                  args.testActor ? "authorize_authenticated_sms_test_inline_action" : "authorize_prospect_sms_inline_action",
                  {
                    p_burst_id: args.prospectBurst!.burstId,
                    p_revision: args.prospectBurst!.revision,
                    p_worker_id: args.prospectBurst!.workerId,
                    p_tool_call_id: call.id,
                    p_tool_name: call.name,
                    ...(args.testActor ? { p_test_actor_user_id: args.testActor.userId } : {}),
                    ...(args.testActor ? { p_test_session_id: args.testActor.sessionId ?? args.prospectBurst!.testSessionId } : {}),
                  },
                );
                const authorized = !error && data === true;
                if (authorized) inlineActionAuthorized = true;
                return authorized;
              }
            : undefined,
          releaseInlineWrite: args.prospectBurst
            ? async (call) => {
                const { data, error } = await db.rpc(
                  args.testActor ? "release_authenticated_sms_test_inline_action" : "release_prospect_sms_inline_action",
                  {
                    p_burst_id: args.prospectBurst!.burstId,
                    p_revision: args.prospectBurst!.revision,
                    p_worker_id: args.prospectBurst!.workerId,
                    p_tool_call_id: call.id,
                    ...(args.testActor ? { p_test_actor_user_id: args.testActor.userId } : {}),
                    ...(args.testActor ? { p_test_session_id: args.testActor.sessionId ?? args.prospectBurst!.testSessionId } : {}),
                  },
                );
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
      toolTrace: [],
      candidateContext: [],
    };
  }
  // The standing no-em-dash rule, applied once where the prospect-visible reply is finalized, so
  // every consumer (the durable prepared reply, the carrier send, the reminder, the manager's
  // "Replied: ..." notice) carries the same stripped text.
  const reply = quietHandoff ? "" : stripLongDashes(result!.reply).trim().slice(0, maxReplyChars);
  if (!reply && !quietHandoff) {
    console.warn("leasing-sms turn produced no reply", session.id, result?.terminationReason);
    return null;
  }
  const toolTrace = result?.toolTrace ?? observedToolTrace;

  if (args.prospectBurst) {
    // This is deliberately separate from the 24-message transcript: canonical
    // property/contact/constraint facts survive history truncation. A failed
    // context write never blocks a valid prospect reply or booking boundary.
    await persistProspectTourSchedulingContext(db, {
      managerUserId: session.landlord_id,
      conversationKey,
      ...(args.testActor
        ? {
            testActorUserId: args.testActor.userId,
            testSessionId: args.testActor.sessionId ?? args.prospectBurst.testSessionId ?? session.id,
          }
        : { trustedPhoneE164: prospectPhone }),
      trustedInboundText: text,
      burst: {
        id: args.prospectBurst.burstId,
        revision: args.prospectBurst.revision,
        workerId: args.prospectBurst.workerId,
      },
      evidence: (result?.toolEvidence ?? []).filter((item) => item.tool !== "suppress_redundant_reply"),
    }).catch((error) => console.error("prospect tour scheduling context persistence failed", error));
  }

  // A queued candidate is not conversation history. Durable SMS history comes
  // from manager_sms_messages, which is appended only after provider accepts
  // submission. Legacy synchronous and voice turns retain agent_messages.
  let assistantMessageId: string | null = null;
  if ((!args.prospectBurst || args.testActor) && !quietHandoff) {
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
  const shadowTools = args.prospectBurst && result && isProspectGptShadowEnabled()
    ? toAnthropicTools(leasingSmsAgentRegistry, { readOnly: true })
    : [];
  const shadowToolNames = new Set(shadowTools.map((tool) => tool.name));
  const shadowToolEvidence = (result?.toolEvidence ?? []).filter((item) => shadowToolNames.has(item.tool));

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
    shadowInput: shadowTools.length > 0 && args.prospectBurst && result ? {
      burstId: args.prospectBurst.burstId,
      burstRevision: args.prospectBurst.revision,
      promptId: turnPromptMeta?.promptId,
      promptHash: turnPromptMeta?.promptHash,
      release: turnPromptMeta?.release,
      primaryProvider: result.provider ?? "anthropic",
      primaryModel: result.model ?? TIER_MODELS.standard,
      primaryOutput: reply,
      primaryEvidence: {
        ...projectProspectShadowPrimaryEvidence(shadowToolEvidence.map((item) => ({
          name: item.tool,
          arguments: item.input,
          output: item.output,
        }))),
        toolCalls: shadowToolEvidence.map((item) => ({ name: item.tool, arguments: item.input })),
      },
      repetitionEvidence: prospectRepetitionEvidence(
        text,
        recentDeliveredReplies.map((item) => item.text),
      ),
      conversation: shadowPreTurnConversation,
      preTurnConversation: shadowPreTurnConversation,
      system: shadowSystem,
      tools: shadowTools,
      toolEvidence: shadowToolEvidence.map((item) => ({
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
  if (args.testActor) return execute();
  const creditKey = await commsTurnKey(db, session.landlord_id, `ai_turn:${channel}:${session.id}:${inboundMessageId}`);
  // W009: name the workspace this send's own work number actually belongs to
  // rather than letting `reserveCommsCredit` default to the owner's default
  // workspace — the line a prospect is texting may hold a non-default house.
  // Under the messaging-credit pool (which needs a real workspace to pick a
  // funder), an unresolvable workspace refuses the turn outright rather than
  // guessing; the legacy per-workspace wallet keeps its existing
  // default-workspace fallback when the number cannot be placed, so this is
  // never a behavior change while the pool is off.
  const workspaceId = (await workspaceOwnedBy(db, session.landlord_id, args.workspaceId))
    ?? (await resolveWorkspaceIdForWorkNumber(db, session.landlord_id, args.workNumber));
  if (!workspaceId && isCommsCreditPoolEnabled()) {
    console.warn("leasing-sms turn skipped: workspace unknown", { sessionId: session.id, managerUserId: session.landlord_id });
    return null;
  }
  const credit = await reserveCommsCredit(db, { managerUserId: session.landlord_id, workspaceId: workspaceId ?? undefined, meter: "ai_agent_turn",
    idempotencyKey: creditKey, metadata: { sessionId: session.id, channel } });
  if (!credit.allowed) {
    console.warn("leasing-sms turn skipped: comms credit not reserved", { sessionId: session.id, managerUserId: session.landlord_id, reason: credit.reason });
    return null;
  }
  if (credit.duplicate) return readCommsTurnResult<LeasingSmsTurn>(db, session.landlord_id, creditKey, {
    reply: INTERRUPTED_COMMS_REPLY,
    suppressed: false,
    sessionId: session.id,
    inboundMessageId,
    assistantMessageId: null,
    traceId: null,
  });
  const outcome = await execute();
  if (!outcome && !toolsRan) {
    // A failed model call (provider outage, bad key) is not a turn. Caching it
    // as a completed `null` silenced the prospect forever and billed the
    // manager; release the hold so the retry reserves a fresh key and runs.
    await finishCommsCredit(db, session.landlord_id, creditKey, true);
    return null;
  }
  return completeCommsTurn(db, session.landlord_id, creditKey, outcome, toolsRan);
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
  prospectTourBookingConfirmationId?: string | null;
  /** Delivery feel (shared line): the workspace names the bubble setting. */
  workspaceId?: string | null;
  bubbles?: boolean;
  inboundText?: string | null;
}): Promise<import("@/lib/proplane-sms-transport.server").PropLaneSmsResult> {
  const { redactedInboundReplyOverride } = await import("@/lib/one-number/redact-reply.server");
  const { deliverAgentReply, bubbleDedupeKey } = await import("@/lib/one-number/bubble-delivery.server");
  // Segment guard: a curly quote or emoji would bill this reply as UCS-2.
  const text = toGsm7((await redactedInboundReplyOverride(args.inboundMessageSid)) ?? args.text);
  const baseKey = args.inboundMessageSid?.trim() ? `inbound_reply_${args.inboundMessageSid.trim()}` : null;
  const result = await deliverAgentReply({
    workspaceId: args.workspaceId,
    // A booking confirmation is exact-once and revision-fenced: it is never split.
    bubbles: args.prospectTourBookingConfirmationId ? false : args.bubbles,
    text,
    inboundText: args.inboundText,
    send: (bubble, index) =>
      sendFromManagerWorkNumber({
        managerUserId: args.landlordId,
        to: args.toPhone,
        text: bubble,
        fromNumber: args.workNumber,
        source: "automated",
        counterpartyRole: "prospect",
        conversationKey: buildConversationKey({
          ownerManagerUserId: args.landlordId,
          role: "prospect",
          counterpartyPhone: args.toPhone,
        }),
        dedupeKey: bubbleDedupeKey(baseKey, index),
        purpose: "manager_conversation",
        actorUserId: args.landlordId,
        traceId: args.traceId,
        // The durable burst fence and the booking confirmation belong to the FIRST bubble only;
        // the follow-up bubbles are ordinary replies in the same conversation.
        ...(index === 0
          ? { prospectBurst: args.prospectBurst, prospectTourBookingConfirmationId: args.prospectTourBookingConfirmationId }
          : {}),
      }),
  });
  // The thread shows the reply that was sent, so the inbox never also drafts
  // for a text this agent already answered (one responder per inbound).
  if (result.ok || result.durablyAccepted) {
    await recordAutoReplyOnSmsNoticeFresh({
      managerUserId: args.landlordId,
      counterpartyPhone: args.toPhone,
      text: args.text,
      inboundMessageId: args.inboundMessageSid,
    });
  }
  return result;
}
