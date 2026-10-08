import "server-only";

/**
 * The AI that answers texts on a vendor's PropLane number. Runs only for a
 * counterpart who is NOT a manager's work line (a manager texting a vendor is a
 * job conversation and goes to the vendor as it always did), after the text is
 * already stored in the vendor's inbox. Answer-only: it reads the vendor's AI
 * info and may hand off to the vendor; it books and commits nothing.
 *
 * Cost and safety bounds: replies leave through `deliverVendorWorkIdentity`, so
 * every one counts against the number's monthly cap and respects opt-outs; each
 * sender gets at most {@link VENDOR_AI_REPLIES_PER_SENDER_PER_HOUR} AI model turns
 * an hour and a vendor at most {@link VENDOR_AI_TURNS_PER_VENDOR_PER_DAY} a day,
 * counted from durable rows (never from memory) and counting every attempt, sent or
 * not. The model is never called when the reply could not leave anyway (monthly cap
 * spent, sender opted out, number paused or not ready), so blocked sends cannot run up
 * model cost. A missing model key,
 * a model error, or a vendor with no AI info at all means no reply and no error:
 * the text is already in the inbox.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn, type AgentTurnResult } from "@/lib/agent/loop";
import { TIER_MODELS } from "@/lib/agent/model";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { composeAgentSystemPrompt } from "@/lib/agent/system-prompts";
import { VENDOR_NUMBER_AI_SURFACE_PROMPT } from "@/lib/agent/vendor-number-ai-system-prompt";
import { traceAgentTurn } from "@/lib/observability/langfuse";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { buildVendorNumberAiContext, type VendorNumberAiContext } from "@/lib/tools/vendor-number-ai-context";
import { VENDOR_NUMBER_AI_WRITE_TOOLS, vendorNumberAiRegistry } from "@/lib/tools/vendor-number-ai-index";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { vendorNumberMonthStart } from "@/lib/vendor-work-number";
import { vendorAiInfoIsEmpty } from "@/lib/vendor-ai-info";
import { loadVendorBusinessProfile } from "@/lib/vendor-business-profile.server";
import { handOffToVendor } from "@/lib/vendor-number-ai-handoff.server";
import type { ActiveVendorNumber } from "@/lib/vendor-work-identity.server";
import { deliverVendorWorkIdentity, type VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";

export const VENDOR_AI_REPLIES_PER_SENDER_PER_HOUR = 5;
/** Ceiling on AI model turns for one vendor's number per rolling day, across every sender. */
export const VENDOR_AI_TURNS_PER_VENDOR_PER_DAY = 200;
/** Usage-event meter every model turn is recorded under (before the model is called). */
export const VENDOR_AI_TURN_METER = "ai_turn";
const REPLY_MAX_LENGTH = 480;
const HISTORY_TURNS = 6;
export const VENDOR_NUMBER_AI_SYSTEM_PROMPT = composeAgentSystemPrompt(VENDOR_NUMBER_AI_SURFACE_PROMPT, "sms");

export type VendorNumberAiOutcome =
  | "replied"
  | "no_info"
  | "rate_limited"
  | "daily_limit"
  | "send_blocked"
  | "unavailable"
  | "empty_reply"
  | "not_delivered";

export type VendorNumberAiTurn = (args: {
  ctx: VendorNumberAiContext;
  messages: Anthropic.MessageParam[];
}) => Promise<Pick<AgentTurnResult, "reply">>;

/** A stable, non-reversible id for a sender's phone: safe for traces, metadata and idempotency keys. */
export function hashSenderPhone(phone: string): string {
  return createHash("sha256").update(phone.trim(), "utf8").digest("hex").slice(0, 16);
}

const turnKey = (senderHash: string, messageSid: string) => `vendor-ai-turn:${senderHash}:${messageSid}`;

/**
 * AI attempts to one sender since `since`: the larger of the durable outbox rows (every status,
 * blocked and failed included) and the model turns recorded before each model call.
 */
export async function countRecentAiRepliesToSender(
  db: SupabaseClient,
  args: { vendorUserId: string; recipient: string; since: Date },
): Promise<number> {
  const since = args.since.toISOString();
  const { count, error } = await db
    .from("vendor_work_identity_outbox")
    .select("id", { count: "exact", head: true })
    .eq("vendor_user_id", args.vendorUserId)
    .eq("channel", "sms")
    .eq("recipient", args.recipient)
    .like("idempotency_key", "vendor-ai:%")
    .gte("created_at", since);
  if (error) throw new Error("AI reply count unavailable.");
  const { count: turns, error: turnError } = await db
    .from("vendor_work_identity_usage_events")
    .select("id", { count: "exact", head: true })
    .eq("vendor_user_id", args.vendorUserId)
    .eq("meter", VENDOR_AI_TURN_METER)
    .like("idempotency_key", turnKey(hashSenderPhone(args.recipient), "%"))
    .gte("created_at", since);
  if (turnError) throw new Error("AI reply count unavailable.");
  return Math.max(count ?? 0, turns ?? 0);
}

/** Model turns this vendor's number has used since `since`, across every sender. */
export async function countRecentAiTurnsForVendor(db: SupabaseClient, args: { vendorUserId: string; since: Date }): Promise<number> {
  const { count, error } = await db
    .from("vendor_work_identity_usage_events")
    .select("id", { count: "exact", head: true })
    .eq("vendor_user_id", args.vendorUserId)
    .eq("meter", VENDOR_AI_TURN_METER)
    .gte("created_at", args.since.toISOString());
  if (error) throw new Error("AI turn count unavailable.");
  return count ?? 0;
}

/**
 * Why a reply to this sender could not leave right now (read-only: nothing is consumed), or null.
 * Mirrors the gates `deliverVendorWorkIdentity` applies, so the model is not paid to write a text
 * that will be blocked. Any unreadable state counts as blocked.
 */
export async function vendorReplyBlocker(
  db: SupabaseClient,
  args: { number: ActiveVendorNumber; recipient: string; provider: VendorDeliveryProvider; now: Date },
): Promise<string | null> {
  try {
    const { data: runtime, error: runtimeError } = await db.from("vendor_work_identity_runtime")
      .select("enabled,outbound_message_cap").eq("singleton", true).maybeSingle();
    const rt = runtime as { enabled?: boolean; outbound_message_cap?: unknown } | null;
    if (runtimeError || !rt?.enabled) return "provider_disabled";
    if (!args.provider.configured("sms")) return "provider_unconfigured";
    const { data: identity, error: identityError } = await db.from("vendor_work_identities")
      .select("sms_state,sms_send_ready").eq("id", args.number.identityId).eq("vendor_user_id", args.number.vendorUserId).maybeSingle();
    const row = identity as { sms_state?: unknown; sms_send_ready?: unknown } | null;
    if (identityError || !row || row.sms_state !== "ready" || row.sms_send_ready !== true) return "identity_not_ready";
    const cap = Number(rt.outbound_message_cap ?? 0);
    const { data: usage, error: usageError } = await db.from("vendor_work_identity_usage_events")
      .select("quantity").eq("identity_id", args.number.identityId).eq("meter", "outbound_sms")
      .gte("created_at", vendorNumberMonthStart(args.now).toISOString());
    if (usageError) return "usage_unavailable";
    const used = ((usage ?? []) as { quantity?: unknown }[]).reduce((sum, r) => sum + Number(r.quantity ?? 0), 0);
    if (!(cap > 0) || used + 1 > cap) return "platform_cap_reached";
    const suppression = await readSmsSuppressionState(db, args.recipient);
    if (!suppression.ok) return suppression.error;
    if (suppression.optedOut) return "recipient_opted_out";
    return null;
  } catch {
    return "blocker_check_failed";
  }
}

/** The last few turns of this conversation (before the current text), as alternating model messages. */
async function recentHistory(db: SupabaseClient, vendorUserId: string, threadId: string | undefined): Promise<Anthropic.MessageParam[]> {
  if (!threadId) return [];
  const { data } = await db.from("portal_inbox_thread_records").select("row_data")
    .eq("id", threadId).eq("owner_user_id", vendorUserId).maybeSingle();
  const messages = ((data as { row_data?: { messages?: unknown } } | null)?.row_data?.messages ?? []) as
    { body?: unknown; outbound?: unknown; automated?: unknown }[];
  const turns: Anthropic.MessageParam[] = [];
  for (const m of messages.slice(-(HISTORY_TURNS + 1), -1)) {
    const body = typeof m.body === "string" ? m.body.trim() : "";
    if (!body || m.automated) continue;
    const role = m.outbound === true ? "assistant" : "user";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${String(last.content)}\n${body}`;
    else turns.push({ role, content: body });
  }
  while (turns.length > 0 && turns[0]!.role !== "user") turns.shift();
  return turns;
}

const defaultTurn: VendorNumberAiTurn = async ({ ctx, messages }) => {
  const system = VENDOR_NUMBER_AI_SYSTEM_PROMPT;
  return traceAgentTurn(
    // Stamped with the vendor's user id, the session keyed to the vendor + a hash of the sender (never the raw phone or text).
    { userId: ctx.vendorUserId, sessionId: `vendor-number-ai:${ctx.vendorUserId}:${hashSenderPhone(ctx.senderPhone)}`, metadata: { surface: "vendor_number_ai", vendorUserId: ctx.vendorUserId } },
    messages as { role: string; content: string }[],
    (observer) =>
      runAgentTurn({
        ctx,
        registry: vendorNumberAiRegistry,
        messages,
        observer,
        system,
        model: { model: TIER_MODELS.standard, tier: "standard" },
        readOnly: true,
        allowWriteTools: VENDOR_NUMBER_AI_WRITE_TOOLS,
      }),
    { name: "vendor-number-ai-turn", promptMeta: resolvePromptMeta(PROMPT_IDS.vendorNumberAi, system) },
  );
};

export async function runVendorNumberAiReply(
  db: SupabaseClient,
  input: {
    number: ActiveVendorNumber;
    from: string;
    text: string;
    messageSid: string;
    threadId?: string;
    now?: Date;
  },
  deps: { provider: VendorDeliveryProvider; turn?: VendorNumberAiTurn },
): Promise<VendorNumberAiOutcome> {
  const now = input.now ?? new Date();
  const vendorUserId = input.number.vendorUserId;
  const profile = await loadVendorBusinessProfile(db, vendorUserId);
  // Nothing written for the AI to say: do nothing, the text is already in the inbox.
  if (vendorAiInfoIsEmpty(profile.aiInfo)) return "no_info";

  // The model is never paid to write a text that cannot leave: monthly cap spent, sender opted out,
  // number paused or not ready. The text is already in the inbox.
  const blocker = await vendorReplyBlocker(db, { number: input.number, recipient: input.from, provider: deps.provider, now });
  if (blocker) {
    console.info("vendor number AI skipped", blocker);
    return "send_blocked";
  }

  const ctx = buildVendorNumberAiContext(db, {
    vendorUserId, senderPhone: input.from, senderText: input.text, messageSid: input.messageSid,
    forwardToPhone: input.number.forwardToPhone, provider: deps.provider, now,
  });

  const sent = await countRecentAiRepliesToSender(db, { vendorUserId, recipient: input.from, since: new Date(now.getTime() - 3_600_000) });
  if (sent >= VENDOR_AI_REPLIES_PER_SENDER_PER_HOUR) {
    // No reply, but the vendor is told this sender is still waiting.
    await handOffToVendor(db, {
      vendorUserId, senderPhone: input.from, senderText: input.text, messageSid: input.messageSid,
      reason: "This person has texted several times this hour and the AI has stopped replying.",
      forwardToPhone: input.number.forwardToPhone, provider: deps.provider, now,
    });
    return "rate_limited";
  }

  // One vendor's number cannot run up model cost across many senders.
  const dayTurns = await countRecentAiTurnsForVendor(db, { vendorUserId, since: new Date(now.getTime() - 86_400_000) });
  if (dayTurns >= VENDOR_AI_TURNS_PER_VENDOR_PER_DAY) return "daily_limit";

  if (!deps.turn && !process.env.ANTHROPIC_API_KEY?.trim()) return "unavailable";
  // Record the attempt BEFORE the model runs, so a failed, empty or undeliverable turn still counts.
  // An attempt that cannot be recorded is an attempt that cannot be limited: no model call.
  const { error: recordError } = await db.from("vendor_work_identity_usage_events").upsert({
    identity_id: input.number.identityId, vendor_user_id: vendorUserId, meter: VENDOR_AI_TURN_METER,
    idempotency_key: turnKey(hashSenderPhone(input.from), input.messageSid),
  }, { onConflict: "idempotency_key" });
  if (recordError) {
    console.warn("vendor number AI turn not recorded", recordError.message);
    return "unavailable";
  }
  let reply: string;
  try {
    const history = await recentHistory(db, vendorUserId, input.threadId);
    const result = await (deps.turn ?? defaultTurn)({ ctx, messages: [...history, { role: "user", content: input.text }] });
    reply = result.reply.trim();
  } catch (error) {
    console.warn("vendor number AI turn failed", error instanceof Error ? error.message : error);
    return "unavailable";
  }
  if (!reply) return "empty_reply";
  // The first AI reply to a sender says what it is; the cap on length keeps it to a segment or two.
  if (sent === 0) reply = `AI assistant for ${profile.businessName.trim() || "this business"}: ${reply}`;
  reply = reply.slice(0, REPLY_MAX_LENGTH);

  const delivered = await deliverVendorWorkIdentity(db, {
    vendorUserId, channel: "sms", recipient: input.from, recipientUserId: null,
    subject: "Text message", text: reply, idempotencyKey: `vendor-ai:${input.messageSid}`, sendClass: "transactional",
  }, deps.provider);
  // A paused / STOPped / capped / unconfigured send is not an error: the text is in PropLane.
  if (!delivered.ok) {
    if (!delivered.authorized) console.info("vendor number AI reply not sent", delivered.reason);
    return "not_delivered";
  }

  const sender = `${input.from}@sms.proplane.local`;
  await deliverPortalMessageThreadSide(db, {
    scope: scopeForRole("vendor"), folder: "inbox", ownerUserId: vendorUserId,
    participantEmail: sender, otherPartyEmail: sender,
    conversation: { otherPartyPhone: input.from },
    fallbackId: `vendor-inbound-sms:${vendorUserId}:${input.from}`,
    fromName: profile.businessName.trim() || "You", subject: "Text message", body: reply,
    preview: reply.slice(0, 100).replace(/\n/g, " "),
    when: formatPacificDateTime(now), unread: false, outbound: true,
    messageId: `vendor-ai-sms:${input.messageSid}`, channel: "sms", messageSubject: "Text message", sentByAi: true,
  }).catch((error) => console.error("vendor number AI inbox copy failed", error instanceof Error ? error.message : error));
  return "replied";
}
