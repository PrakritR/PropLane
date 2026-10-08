import "server-only";

/**
 * The resident's personal PropLane agent: one inbound text from the NUMBER OWNER's own verified phone
 * becomes one outbound reply from their number (docs/ai-assistant.md § Resident personal agent).
 *
 * Its own surface, never the manager, leasing, resident-portal or vendor ones:
 *  - Identity is the owner of the texted number (`resident_agent_numbers`), resolved before this module
 *    runs. The sender's phone must equal that owner's VERIFIED phone or the caller never gets here;
 *    nothing in the message text can name or change who is acting.
 *  - Credit is reserved from the resident's number ledger (`reserveNumberCredit`) BEFORE the model or
 *    the provider is touched: one AI turn plus the reply's worst-case segments. A turn that cannot be
 *    paid for answers with a short out-of-credit text only if THAT text is itself affordable, else with
 *    nothing. Unused segments are refunded when the reply is sized.
 *  - Writes are confirm-first: the loop proposes, the resident is texted the exact request, and only
 *    their YES (an exact, small vocabulary) runs the handler through the shared confirm gate under the
 *    `resident_agent` portal. A YES is an authorization, so it never reaches the model.
 *  - Every turn is traced (`traceAgentTurn`); phone numbers are hashed in the session id.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn, type AgentTurnResult } from "@/lib/agent/loop";
import { TIER_MODELS } from "@/lib/agent/model";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { composeAgentSystemPrompt } from "@/lib/agent/system-prompts";
import { assistantClockBlock } from "@/lib/agent/assistant-turn-context";
import { RESIDENT_PERSONAL_AGENT_SURFACE_PROMPT } from "@/lib/agent/resident-personal-agent-system-prompt";
import { decidePendingAction } from "@/lib/agent/pending-action-decision";
import { findOrCreateSmsAgentSession } from "@/lib/agent/sms-agent-turn.server";
import { traceAgentTurn } from "@/lib/observability/langfuse";
import {
  classifySmsConfirmationReply,
  resolveOpenSmsProposal,
  supersedeOpenSmsProposals,
  SMS_PENDING_ACTION_TTL_MS,
} from "@/lib/sms/agent-confirmation.server";
import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";
import { createPendingActionForUser } from "@/lib/tools/pending-actions";
import type { ActionPreview } from "@/lib/tools/registry";
import {
  buildResidentPersonalAgentContext,
  type ResidentPersonalAgentContext,
} from "@/lib/tools/resident-personal-agent-context";
import {
  RESIDENT_PERSONAL_AGENT_INLINE_WRITE_TOOLS,
  residentPersonalAgentRegistry,
} from "@/lib/tools/resident-personal-agent-index";
import { finishNumberCredit, reserveNumberCredit, settleNumberCreditQuantity } from "@/lib/number-subscription/credit.server";
import { numberServiceEntitled } from "@/lib/number-subscription/subscription.server";
import type { VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";
import { sendFromResidentNumber, residentAgentSendBlocker } from "@/lib/resident-agent-number/deliver.server";
import type { ResidentAgentNumber } from "@/lib/resident-agent-number/number.server";

export const RESIDENT_AGENT_SESSION_KIND = "resident_personal_sms";
export const RESIDENT_AGENT_PORTAL = "resident_agent" as const;
/** A reply never exceeds this many carrier segments, so its cost is known before the model runs. */
export const RESIDENT_AGENT_MAX_REPLY_SEGMENTS = 4;
const MAX_INBOUND_PER_HOUR = 30;
const HISTORY_LIMIT = 24;
const INBOUND_MAX_CHARS = 1000;
export const RESIDENT_AGENT_SYSTEM_PROMPT = composeAgentSystemPrompt(RESIDENT_PERSONAL_AGENT_SURFACE_PROMPT, "sms");

export const RESIDENT_AGENT_OUT_OF_CREDIT_TEXT =
  "You're out of PropLane message credit. Add credit in Settings, PropLane agent, and I'll pick this back up.";
const RESIDENT_AGENT_TOO_LONG_TEXT = "That is too long to confirm by text. Send a shorter version and I'll set it up.";
const MODEL_ERROR_TEXT = "I hit a snag. Please text that again in a moment.";

export type ResidentAgentOutcome =
  | "replied"
  | "duplicate"
  | "not_entitled"
  | "unavailable"
  | "send_blocked"
  | "rate_limited"
  | "out_of_credit_notice"
  | "out_of_credit_silent"
  | "empty_reply"
  | "not_delivered";

export type ResidentAgentModelTurn = (args: {
  ctx: ResidentPersonalAgentContext;
  messages: Anthropic.MessageParam[];
  system: string;
  sessionId: string;
}) => Promise<Pick<AgentTurnResult, "reply" | "toolTrace" | "pendingAction"> & { traceId?: string | null }>;

/** A stable, non-reversible id for a phone: safe for traces, session ids and idempotency keys. */
export function hashPhoneForTrace(phone: string): string {
  return createHash("sha256").update(phone.trim(), "utf8").digest("hex").slice(0, 16);
}

const keys = (sid: string) => ({
  inbound: `rpa-in:${sid}`,
  ai: `rpa-ai:${sid}`,
  out: `rpa-out:${sid}`,
  notice: `rpa-nocredit:${sid}`,
});

function segmentsOf(text: string): number {
  return Math.max(1, estimateSmsSegments(text).segmentCount);
}

/** Trim to the segment budget the credit was reserved for, at a word edge where possible. */
export function fitToSegments(text: string, maxSegments: number): string {
  let out = text.trim();
  while (out.length > 1 && estimateSmsSegments(out).segmentCount > maxSegments) {
    const cut = Math.max(1, Math.floor(out.length * 0.9));
    const space = out.lastIndexOf(" ", cut);
    out = `${out.slice(0, space > cut * 0.6 ? space : cut).trimEnd()}…`;
  }
  return out;
}

/** Fields whose text the resident is approving word for word: they are shown in full, never clipped. */
const VERBATIM_PREVIEW_LABELS = new Set(["Message", "Notes"]);

/**
 * The confirmation text: a compact preview that always ends with the YES/NO instruction. A YES sends
 * exactly what this text shows, so the resident's own words (`Message`, `Notes`) are never clipped; the
 * lead, the other fields and finally the other fields entirely give way first. Returns null when the
 * verbatim fields alone cannot fit the reserved segments (the caller asks for something shorter and
 * proposes nothing).
 */
export function renderResidentAgentPreview(preview: ActionPreview, lead: string, maxSegments = RESIDENT_AGENT_MAX_REPLY_SEGMENTS): string | null {
  const confirmLine = "Reply YES to send or NO to cancel.";
  const clip = (value: string, n: number) => (value.length > n ? `${value.slice(0, n - 1).trimEnd()}…` : value);
  const fields = preview.fields ?? [];
  const narrative = lead.trim();
  const fits = (text: string) => estimateSmsSegments(text).segmentCount <= maxSegments;
  const render = (kept: typeof fields, fieldCap: number) =>
    [preview.title, ...kept.map((f) => `${f.label}: ${VERBATIM_PREVIEW_LABELS.has(f.label) ? f.value : clip(f.value, fieldCap)}`), confirmLine].join("\n");
  const tries: [typeof fields, number][] = [
    ...[160, 100, 60, 30].map((cap): [typeof fields, number] => [fields, cap]),
    [fields.filter((f) => VERBATIM_PREVIEW_LABELS.has(f.label)), 30],
  ];
  for (const [kept, fieldCap] of tries) {
    const core = render(kept, fieldCap);
    for (const candidate of [narrative ? `${clip(narrative, 140)}\n\n${core}` : core, core]) {
      if (fits(candidate)) return candidate;
    }
  }
  if (fields.some((f) => VERBATIM_PREVIEW_LABELS.has(f.label))) return null;
  return fitToSegments(`${preview.title}\n${confirmLine}`, maxSegments);
}

async function recordMessage(
  db: SupabaseClient,
  session: { id: string; landlord_id: string },
  role: "user" | "assistant",
  content: string,
  sourceMessageSid: string | null,
  extra: { toolTrace?: unknown; traceId?: string | null } = {},
): Promise<{ id: string | null; duplicate: boolean }> {
  const { data, error } = await db
    .from("agent_messages")
    .insert({
      session_id: session.id,
      landlord_id: session.landlord_id,
      role,
      content,
      channel: "sms",
      tool_trace: extra.toolTrace ?? [],
      trace_id: extra.traceId ?? null,
      source_message_sid: sourceMessageSid,
    })
    .select("id")
    .maybeSingle();
  if (error) return { id: null, duplicate: error.code === "23505" };
  return { id: data?.id ? String(data.id) : null, duplicate: false };
}

async function recentHistory(db: SupabaseClient, sessionId: string, currentText: string): Promise<Anthropic.MessageParam[]> {
  const { data } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const rows = ((data ?? []) as { role: string; content: string }[]).reverse();
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of rows) {
    const role = row.role === "assistant" ? "assistant" : "user";
    const content = String(row.content ?? "").trim();
    if (!content) continue;
    const last = out.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n${content}`;
    else out.push({ role, content });
  }
  while (out[0] && out[0].role === "assistant") out.shift();
  if (out.length === 0 || out.at(-1)!.role !== "user") out.push({ role: "user", content: currentText });
  return out as Anthropic.MessageParam[];
}

const defaultTurn: ResidentAgentModelTurn = async ({ ctx, messages, system, sessionId }) => {
  let traceId: string | null = null;
  const result = await traceAgentTurn(
    {
      userId: ctx.userId,
      // Keyed to the resident and a hash of their phone: never the raw number or the text.
      sessionId: `resident-personal-agent:${ctx.userId}:${hashPhoneForTrace(ctx.phoneE164)}`,
      metadata: { surface: "resident_personal_agent", role: "resident", channel: "sms", agentSessionId: sessionId },
    },
    messages as { role: string; content: string }[],
    (observer) =>
      runAgentTurn({
        ctx,
        registry: residentPersonalAgentRegistry,
        messages,
        observer,
        system,
        model: { model: TIER_MODELS.standard, tier: "standard" },
        // Writes are NOT inline: the loop proposes and the resident confirms by text.
        readOnly: false,
        allowWriteTools: RESIDENT_PERSONAL_AGENT_INLINE_WRITE_TOOLS,
      }),
    {
      name: "resident-personal-agent-turn",
      promptMeta: resolvePromptMeta(PROMPT_IDS.residentPersonalAgent, system),
      onTraceId: (id) => {
        traceId = id;
      },
    },
  );
  return { reply: result.reply, toolTrace: result.toolTrace, pendingAction: result.pendingAction, traceId };
};

type Deps = { provider: VendorDeliveryProvider; turn?: ResidentAgentModelTurn; loadListings?: () => Promise<import("@/data/types").MockProperty[]> };

/** Text the resident from their own number, settling the reply's credit to what was really sent. */
async function sendAndSettle(
  db: SupabaseClient,
  args: { number: ResidentAgentNumber; to: string; text: string; outKey: string; provider: VendorDeliveryProvider },
): Promise<boolean> {
  const sent = await sendFromResidentNumber(db, {
    number: args.number,
    to: args.to,
    text: args.text,
    idempotencyKey: args.outKey,
    provider: args.provider,
  });
  if (sent.ok) {
    await settleNumberCreditQuantity(args.number.residentUserId, args.outKey, segmentsOf(args.text), { db }).catch((e) =>
      console.error("resident agent credit settle failed", e instanceof Error ? e.message : e),
    );
    return true;
  }
  // The provider did not take it (or its outcome is unknown and is never retried): hand the credit back.
  await finishNumberCredit(args.number.residentUserId, args.outKey, { release: sent.reason !== "provider_outcome_unknown", db }).catch(() => undefined);
  return false;
}

export async function runResidentPersonalAgentReply(
  db: SupabaseClient,
  input: { number: ResidentAgentNumber; from: string; text: string; messageSid: string; now?: Date },
  deps: Deps,
): Promise<ResidentAgentOutcome> {
  const { number } = input;
  const ownerId = number.residentUserId;
  const text = input.text.trim().slice(0, INBOUND_MAX_CHARS);
  const k = keys(input.messageSid);

  if (!text) return "empty_reply";
  // Lapsed or never paid: the text stays a plain text. Nothing is charged, nothing answers.
  if (!(await numberServiceEntitled(ownerId, db))) return "not_entitled";

  const ctx = await buildResidentPersonalAgentContext(db, {
    residentUserId: ownerId,
    messageSid: input.messageSid,
    now: input.now,
    loadListings: deps.loadListings,
  });
  // The texter must still be the account's verified phone. The owner id came from the number, but the
  // phone is re-checked against the account so a recycled or changed number cannot command it.
  if (!ctx || ctx.phoneE164 !== input.from) return "unavailable";

  const session = await findOrCreateSmsAgentSession(db, {
    kind: RESIDENT_AGENT_SESSION_KIND,
    landlordId: ownerId,
    actorUserId: ownerId,
    phoneE164: input.from,
  });
  if (!session) return "unavailable";

  // A retried webhook is the same message: it never re-charges, re-runs or re-answers.
  const inbound = await recordMessage(db, session, "user", text, input.messageSid);
  if (inbound.duplicate) return "duplicate";
  if (!inbound.id) return "unavailable";

  // The text was received whether or not we can answer it: charge what is there (the platform absorbs the rest).
  try {
    await reserveNumberCredit(ownerId, "sms_inbound_segment", segmentsOf(text), k.inbound, { db, allowUnfunded: true });
    await finishNumberCredit(ownerId, k.inbound, { db });
  } catch (e) {
    console.warn("resident agent inbound credit not recorded", e instanceof Error ? e.message : e);
  }

  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await db
    .from("agent_messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", session.id)
    .eq("role", "user")
    .gte("created_at", oneHourAgo);
  if ((count ?? 0) > MAX_INBOUND_PER_HOUR) return "rate_limited";

  // Nothing can leave this number right now (not registered, STOP, provider off): do no paid work.
  const blocker = await residentAgentSendBlocker(db, { number, recipient: input.from, provider: deps.provider });
  if (blocker) {
    console.info("resident agent skipped", blocker);
    return "send_blocked";
  }

  const confirmIntent = classifySmsConfirmationReply(text);
  let open: Awaited<ReturnType<typeof resolveOpenSmsProposal>> = { status: "none" };
  if (confirmIntent !== "none") {
    open = await resolveOpenSmsProposal(db, { userId: ownerId, sessionId: session.id, portal: RESIDENT_AGENT_PORTAL });
  }
  const isDecision = confirmIntent !== "none" && open.status !== "none";

  // ---- Credit: reserve BEFORE the model or the provider. ----
  let aiReserved = false;
  const outFits = await reserveNumberCredit(ownerId, "sms_outbound_segment", RESIDENT_AGENT_MAX_REPLY_SEGMENTS, k.out, { db });
  if (outFits.allowed && !isDecision) {
    const ai = await reserveNumberCredit(ownerId, "ai_agent_turn", 1, k.ai, { db });
    aiReserved = ai.allowed;
    if (!ai.allowed) await finishNumberCredit(ownerId, k.out, { release: true, db });
  }
  if (!outFits.allowed || (!isDecision && !aiReserved)) {
    return await outOfCredit(db, { number, to: input.from, sessionId: session.id, session, messageSid: input.messageSid, provider: deps.provider });
  }

  const reply = await composeReply();
  if (reply === null) {
    await finishNumberCredit(ownerId, k.out, { release: true, db }).catch(() => undefined);
    return "empty_reply";
  }

  const finalText = fitToSegments(reply.text, RESIDENT_AGENT_MAX_REPLY_SEGMENTS);
  const delivered = await sendAndSettle(db, { number, to: input.from, text: finalText, outKey: k.out, provider: deps.provider });
  if (!delivered) return "not_delivered";
  await recordMessage(db, session, "assistant", finalText, input.messageSid, { toolTrace: reply.toolTrace, traceId: reply.traceId });
  return "replied";

  async function composeReply(): Promise<{ text: string; toolTrace: unknown; traceId: string | null } | null> {
    // A YES/NO against the one open proposal: an authorization, never a prompt.
    if (isDecision && open.status === "one") {
      const decision = await decidePendingAction({
        action: { kind: confirmIntent === "deny" ? "deny" : "confirm", actionId: open.actionId },
        ctx: ctx!,
        registry: residentPersonalAgentRegistry,
        portal: RESIDENT_AGENT_PORTAL,
        traceMetadata: { surface: "resident_personal_agent", role: "resident", channel: "sms" },
      });
      if (decision.kind === "denied") {
        return { text: decision.known ? "No problem, I cancelled that. Nothing was sent." : "I could not cancel that. It may have expired.", toolTrace: [], traceId: null };
      }
      const result = decision.result;
      return { text: result.ok ? result.reply : result.error, toolTrace: [], traceId: null };
    }
    if (isDecision && open.status === "ambiguous") {
      return { text: "I have more than one request open and don't want to guess. Tell me which one to go ahead with.", toolTrace: [], traceId: null };
    }
    if (isDecision) {
      return { text: "I could not check that just now. Please try again in a moment.", toolTrace: [], traceId: null };
    }

    // Normal turn.
    if (!deps.turn && !process.env.ANTHROPIC_API_KEY?.trim()) {
      await finishNumberCredit(ownerId, k.ai, { release: true, db }).catch(() => undefined);
      return null;
    }
    const system = `${RESIDENT_AGENT_SYSTEM_PROMPT}\n\n${assistantClockBlock(input.now ?? Date.now())}`;
    let result: Awaited<ReturnType<ResidentAgentModelTurn>>;
    try {
      result = await (deps.turn ?? defaultTurn)({
        ctx: ctx!,
        messages: await recentHistory(db, session!.id, text),
        system,
        sessionId: session!.id,
      });
    } catch (error) {
      console.warn("resident agent turn failed", error instanceof Error ? error.message : error);
      // The model never produced anything: the turn is not charged.
      await finishNumberCredit(ownerId, k.ai, { release: true, db }).catch(() => undefined);
      return { text: MODEL_ERROR_TEXT, toolTrace: [], traceId: null };
    }
    await finishNumberCredit(ownerId, k.ai, { db }).catch(() => undefined);

    if (result.pendingAction) {
      // The text the resident will confirm is built BEFORE anything is proposed: a YES must send exactly
      // what it shows, so a request whose own words cannot fit the confirmation is never proposed.
      const previewText = renderResidentAgentPreview(result.pendingAction.preview, result.reply);
      if (!previewText) return { text: RESIDENT_AGENT_TOO_LONG_TEXT, toolTrace: result.toolTrace, traceId: result.traceId ?? null };
      // One open proposal at a time, so a later bare YES is unambiguous.
      const cleared = await supersedeOpenSmsProposals(db, { userId: ownerId, sessionId: session!.id, portal: RESIDENT_AGENT_PORTAL });
      const actionId = cleared.ok
        ? await createPendingActionForUser(db, {
            landlordId: ownerId,
            userId: ownerId,
            toolName: result.pendingAction.toolName,
            input: result.pendingAction.input,
            preview: result.pendingAction.preview,
            portal: RESIDENT_AGENT_PORTAL,
            sessionId: session!.id,
            expiresInMs: SMS_PENDING_ACTION_TTL_MS,
            proposalTraceId: result.traceId ?? null,
          })
        : null;
      if (!actionId) return { text: "I could not set that up just now. Please try again in a moment.", toolTrace: result.toolTrace, traceId: result.traceId ?? null };
      return {
        text: previewText,
        toolTrace: result.toolTrace,
        traceId: result.traceId ?? null,
      };
    }
    const textReply = result.reply.trim();
    return textReply ? { text: textReply, toolTrace: result.toolTrace, traceId: result.traceId ?? null } : null;
  }
}

/**
 * The turn could not be paid for. Tell the resident - but only if THAT text is itself affordable;
 * otherwise say nothing at all. Nothing is ever taken on credit.
 */
async function outOfCredit(
  db: SupabaseClient,
  args: { number: ResidentAgentNumber; to: string; sessionId: string; session: { id: string; landlord_id: string }; messageSid: string; provider: VendorDeliveryProvider },
): Promise<ResidentAgentOutcome> {
  const k = keys(args.messageSid);
  const ownerId = args.number.residentUserId;
  const notice = fitToSegments(RESIDENT_AGENT_OUT_OF_CREDIT_TEXT, 2);
  const affordable = await reserveNumberCredit(ownerId, "sms_outbound_segment", segmentsOf(notice), k.notice, { db });
  if (!affordable.allowed) return "out_of_credit_silent";
  const delivered = await sendAndSettle(db, { number: args.number, to: args.to, text: notice, outKey: k.notice, provider: args.provider });
  if (delivered) await recordMessage(db, args.session, "assistant", notice, `${args.messageSid}:nocredit`);
  return delivered ? "out_of_credit_notice" : "not_delivered";
}
