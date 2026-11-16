import "server-only";

/**
 * The leasing assistant, reached by the website's chat box (captain, Nov 15).
 *
 * Same brain as the SMS prospect agent: the SAME registry (`leasingSmsAgentRegistry`), the SAME system prompt (the
 * manager's custom instructions included) and the SAME two inline writes (`LEASING_SMS_INLINE_WRITE_TOOLS`: only
 * `escalate_to_manager` and `request_tour`, which merely NOTIFY the manager). A visitor is anonymous, so there is no `user_id` a
 * pending action could be claimed on: nothing else is reachable. What differs is the key: a texter is identified by phone, a
 * visitor by the signed-cookie id, so this is the email agent's sibling (`leasing_web` sessions) rather than
 * `runLeasingSmsAgentTurn`, which requires an E.164 number.
 *
 * The home the visitor is looking at is named to the model from the database row (never the request body); facts still come
 * only from tool results.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { hasAgentModelCredential } from "@/lib/agent/model";
import { runAgentTurn } from "@/lib/agent/loop";
import { leasingSmsSystemPromptForWorkNumberOwner } from "@/lib/agent/leasing-sms-custom-instructions";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { runtimeTaskModel } from "@/lib/agent/runtime-model";
import { stripLongDashes } from "@/lib/agent/conversation-style-rules";
import { traceAgentTurn, type TraceActor } from "@/lib/observability/langfuse";
import { buildLeasingSmsAgentContext } from "@/lib/tools/context";
import { LEASING_SMS_INLINE_WRITE_TOOLS, leasingSmsAgentRegistry } from "@/lib/tools";

const SESSION_KIND = "leasing_web";
const HISTORY_LIMIT = 16;
const MAX_REPLY_CHARS = 1200;

/** The registry and write allow-list a web visitor gets. Exported so a test can pin them equal to the SMS agent's. */
export const WEB_CHAT_REGISTRY = leasingSmsAgentRegistry;
export const WEB_CHAT_INLINE_WRITE_TOOLS = LEASING_SMS_INLINE_WRITE_TOOLS;

const WEB_CHANNEL_INSTRUCTIONS = [
  "",
  "You are answering in the chat box on the PropLane website, not by text. Keep replies short (a few sentences), plain text,",
  "no markdown. The person is anonymous: never ask for an email, a password or any ID. If they give a phone number, say they can",
  "verify it with the code PropLane texts to continue by text; do not text them yourself. When a link would help, call",
  "build_prospect_links for the home and put the one link that answers them in the reply.",
].join("\n");

/** ID-only Langfuse attribution: the visitor id, the workspace owner and the channel. Never the message text. */
export function leasingWebTraceActor(landlordId: string): TraceActor {
  return { userId: landlordId, metadata: { landlordId, role: "prospect", managerIds: [landlordId], channel: "web" } };
}

export async function findOrCreateLeasingWebSession(
  db: SupabaseClient,
  args: { landlordId: string; visitorId: string },
): Promise<{ id: string; landlord_id: string } | null> {
  const landlordId = args.landlordId.trim();
  const key = `web:${args.visitorId.trim()}`;
  if (!landlordId || key === "web:") return null;
  const read = async () => {
    const { data } = await db.from("agent_sessions").select("id, landlord_id").eq("kind", SESSION_KIND).eq("landlord_id", landlordId).eq("vendor_phone_e164", key).maybeSingle();
    return (data as { id: string; landlord_id: string } | null) ?? null;
  };
  const existing = await read();
  if (existing) return existing;
  const { data: created, error } = await db
    .from("agent_sessions")
    .insert({ landlord_id: landlordId, user_id: null, kind: SESSION_KIND, vendor_phone_e164: key, status: "active" })
    .select("id, landlord_id")
    .maybeSingle();
  if (error) return error.code === "23505" ? read() : null;
  return (created as { id: string; landlord_id: string } | null) ?? null;
}

export type LeasingWebTurn = { reply: string; sessionId: string; traceId: string | null };

/** One leasing turn for a web-chat visitor. Null = no reply (no model credential, empty text, a failure, a suppression). */
export async function runLeasingWebAgentTurn(
  db: SupabaseClient,
  args: {
    landlordId: string;
    visitorId: string;
    inboundText: string;
    /** The idempotency key of the visitor's message: a replay never inserts a second user turn. */
    sourceMessageId: string;
    listing: { propertyId: string; label: string; roomLabel: string | null };
  },
): Promise<LeasingWebTurn | null> {
  const text = args.inboundText.trim().slice(0, 1000);
  if (!text) return null;
  const model = runtimeTaskModel();
  if (!hasAgentModelCredential(model)) return null;
  const session = await findOrCreateLeasingWebSession(db, { landlordId: args.landlordId, visitorId: args.visitorId });
  if (!session) return null;

  const { error: inboundError } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "user",
    content: text,
    channel: "web",
    source_message_sid: args.sourceMessageId,
  });
  if (inboundError && inboundError.code !== "23505") {
    console.error("leasing-web inbound persistence failed", session.id, inboundError.message);
    return null;
  }

  const { data: historyRows } = await db.from("agent_messages").select("role, content").eq("session_id", session.id).order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
  const history = ((historyRows ?? []) as { role: string; content: string }[])
    .reverse()
    .map((row) => ({ role: row.role === "assistant" ? "assistant" : "user", content: row.content })) as Anthropic.MessageParam[];
  if (history.length === 0 || history.at(-1)!.role !== "user") history.push({ role: "user", content: text });

  const ctx = buildLeasingSmsAgentContext(db, {
    landlordId: session.landlord_id,
    scope: {
      sessionId: session.id,
      prospectPhoneE164: "",
      prospectEmail: null,
      channel: "email",
      currentInboundText: text,
      workNumber: null,
      crossCatalog: false,
    },
  });

  let traceId: string | null = null;
  try {
    const where = [args.listing.label, args.listing.roomLabel].filter(Boolean).join(", ");
    const system =
      (await leasingSmsSystemPromptForWorkNumberOwner(db, session.landlord_id)) +
      WEB_CHANNEL_INSTRUCTIONS +
      `\n\nThe visitor is on the listing page for ${JSON.stringify(where)} (canonical property id ${JSON.stringify(args.listing.propertyId)}). Resolve and reuse that home unless they ask about another one.` +
      `\n\nToday in Pacific time is ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date())}.`;
    const result = await traceAgentTurn(
      leasingWebTraceActor(session.landlord_id),
      history as { role: string; content: string }[],
      (observer) =>
        runAgentTurn({
          ctx,
          registry: WEB_CHAT_REGISTRY,
          messages: history,
          observer,
          system,
          model,
          readOnly: true,
          allowWriteTools: WEB_CHAT_INLINE_WRITE_TOOLS,
        }),
      {
        name: "axis-leasing-web-turn",
        sessionId: session.id,
        promptMeta: resolvePromptMeta(PROMPT_IDS.leasingSmsAgent, system),
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
    const reply = stripLongDashes(result.reply.trim()).slice(0, MAX_REPLY_CHARS).trim();
    if (!reply) return null;
    await db.from("agent_messages").insert({
      session_id: session.id,
      landlord_id: session.landlord_id,
      role: "assistant",
      content: reply,
      channel: "agent",
      tool_trace: result.toolTrace,
      trace_id: traceId,
    });
    await db.from("agent_sessions").update({ updated_at: new Date().toISOString() }).eq("id", session.id);
    track("leasing_web_message_out", session.landlord_id, { tools: result.toolTrace.length });
    return { reply, sessionId: session.id, traceId };
  } catch (error) {
    console.error("leasing-web agent turn failed", session.id, error instanceof Error ? error.message : "unknown");
    return null;
  }
}
