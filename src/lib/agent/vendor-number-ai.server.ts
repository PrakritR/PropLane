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
 * sender gets at most {@link VENDOR_AI_REPLIES_PER_SENDER_PER_HOUR} AI replies an
 * hour, counted from the durable outbox (never from memory). A missing model key,
 * a model error, or a vendor with no AI info at all means no reply and no error:
 * the text is already in the inbox.
 */
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
import { vendorAiInfoIsEmpty } from "@/lib/vendor-ai-info";
import { loadVendorBusinessProfile } from "@/lib/vendor-business-profile.server";
import { handOffToVendor } from "@/lib/vendor-number-ai-handoff.server";
import type { ActiveVendorNumber } from "@/lib/vendor-work-identity.server";
import { deliverVendorWorkIdentity, type VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";

export const VENDOR_AI_REPLIES_PER_SENDER_PER_HOUR = 5;
const REPLY_MAX_LENGTH = 480;
const HISTORY_TURNS = 6;
export const VENDOR_NUMBER_AI_SYSTEM_PROMPT = composeAgentSystemPrompt(VENDOR_NUMBER_AI_SURFACE_PROMPT, "sms");

export type VendorNumberAiOutcome =
  | "replied"
  | "no_info"
  | "rate_limited"
  | "unavailable"
  | "empty_reply"
  | "not_delivered";

export type VendorNumberAiTurn = (args: {
  ctx: VendorNumberAiContext;
  messages: Anthropic.MessageParam[];
}) => Promise<Pick<AgentTurnResult, "reply">>;

/** AI replies this vendor's number sent to one sender since `since`, from the durable outbox. */
export async function countRecentAiRepliesToSender(
  db: SupabaseClient,
  args: { vendorUserId: string; recipient: string; since: Date },
): Promise<number> {
  const { count, error } = await db
    .from("vendor_work_identity_outbox")
    .select("id", { count: "exact", head: true })
    .eq("vendor_user_id", args.vendorUserId)
    .eq("channel", "sms")
    .eq("recipient", args.recipient)
    .like("idempotency_key", "vendor-ai:%")
    .neq("status", "blocked")
    .gte("created_at", args.since.toISOString());
  if (error) throw new Error("AI reply count unavailable.");
  return count ?? 0;
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
    // Stamped with the vendor's user id, the session keyed to the vendor + sender (never the raw text).
    { userId: ctx.vendorUserId, sessionId: `vendor-number-ai:${ctx.vendorUserId}:${ctx.senderPhone}`, metadata: { surface: "vendor_number_ai", vendorUserId: ctx.vendorUserId } },
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

  if (!deps.turn && !process.env.ANTHROPIC_API_KEY?.trim()) return "unavailable";
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
