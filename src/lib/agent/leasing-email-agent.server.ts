import { runtimeTaskModel } from "@/lib/agent/runtime-model";
import "server-only";

/**
 * The leasing assistant, reached by email instead of text.
 *
 * Same brain as the SMS prospect agent — same registry, same system prompt, same
 * two inline writes — because a prospect asking "is the Capitol Hill room still
 * open?" should get the same answer whichever way they ask. What differs is the
 * key: a texter is identified by their phone, an emailer by their address, so
 * this cannot reuse `runLeasingSmsAgentTurn` (which requires an E.164 number and
 * would have to be handed a fake one).
 *
 * The session is a separate `kind` rather than an email squeezed into the SMS
 * path's `vendor_phone_e164` conversation key. Two prospects — one texting, one
 * emailing — must never share a thread, and a column named for a phone number
 * holding an address is precisely the drift that makes that happen later.
 *
 * `readOnly` and `allowWriteTools` match the SMS prospect agent exactly, and for
 * the same reason: an emailing prospect is anonymous, so there is no `user_id` a
 * pending action could be claimed on and no confirmation card to show them. Only
 * the two writes that merely NOTIFY the manager are reachable.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { runAgentTurn } from "@/lib/agent/loop";
import { leasingSmsSystemPromptForWorkNumberOwner } from "@/lib/agent/leasing-sms-custom-instructions";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { traceAgentTurn } from "@/lib/observability/langfuse";
import { buildLeasingSmsAgentContext } from "@/lib/tools/context";
import { leasingSmsAgentRegistry, LEASING_SMS_INLINE_WRITE_TOOLS } from "@/lib/tools";
import { buildProspectLinksTool, escalateLeasingToManagerTool, getSiteLinksTool, suppressRedundantLeasingReplyTool } from "@/lib/tools/domains/leasing-sms";
import { listOpenTourSlotsTool, leasingRequestTourTool } from "@/lib/tools/domains/tours";
import { buildRegistry, type ToolRegistry } from "@/lib/tools/registry";
import type { AgentContext } from "@/lib/tools/context";
import { leasingSmsTraceActor } from "@/lib/agent/leasing-sms-agent.server";
import {
  channelAgentInstructions,
  channelReplyViolations,
  enforceCheckedAvailability,
  type ChannelHoldReason,
  type ChannelReplyViolation,
} from "@/lib/agent/channel-reply-policy";
import { CHANNEL_SITE_LABEL, channelAllowsContactDetails, type ChannelSite } from "@/lib/inbound-email/channel-senders";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;

const SESSION_KIND = "leasing_email";
const HISTORY_LIMIT = 12;

const EMAIL_CHANNEL_INSTRUCTIONS = [
  "",
  "You are replying by EMAIL, not text. A few sentences or a short paragraph is",
  "right — you are not limited to a text message's length, but do not pad. Do not",
  "sign off with a name or a signature block; the mail already carries one.",
].join("\n");

export type LeasingEmailTurn = {
  reply: string;
  sessionId: string;
  traceId: string | null;
  /** Channel turns only: what the post-checks found. A non-empty `violations` means the reply must be HELD, never sent. */
  channel?: {
    violations: ChannelReplyViolation[];
    /** The model stated availability without a successful checked read; `reply` is the confirm-later text. */
    availabilityReplaced: boolean;
  };
};

/** A guest message from a booking site (Airbnb, Booking.com, PadSplit, SpareRoom) rather than a prospect's own email. */
export type LeasingEmailChannel = {
  site: ChannelSite;
  guestName: string;
  /** "5257 Brooklyn Ave, Room 6" when the listing was matched to a room. */
  listingLine: string | null;
  holdReason: ChannelHoldReason | null;
  /** The workspace is PropLane-managed (`is_service`): the catalog is the homes PropLane manages. */
  serviceWorkspace: boolean;
  /** The PropLane line as the guest should read it, for the sites that allow a number. */
  proplaneLine: string | null;
};

/**
 * The tools a channel turn may use. Airbnb and Booking.com forbid links, so the tools that mint them are removed
 * (the post-check still holds anything that slips through); a channel guest is never "suppressed" as an acknowledgment.
 */
export function channelLeasingRegistry(site: ChannelSite): ToolRegistry<AgentContext> {
  const drop = new Set<string>([suppressRedundantLeasingReplyTool.name]);
  if (!channelAllowsContactDetails(site)) {
    for (const tool of [buildProspectLinksTool, getSiteLinksTool, listOpenTourSlotsTool, leasingRequestTourTool]) drop.add(tool.name);
  }
  return buildRegistry([...leasingSmsAgentRegistry.values()].filter((tool) => !drop.has(tool.name)));
}

/** The writes a channel turn may run inline: only the manager notification on Airbnb and Booking.com. */
export function channelInlineWriteTools(site: ChannelSite): readonly string[] {
  return channelAllowsContactDetails(site) ? LEASING_SMS_INLINE_WRITE_TOOLS : [escalateLeasingToManagerTool.name];
}

async function findOrCreateLeasingEmailSession(
  db: SupabaseClient,
  args: { landlordId: string; prospectEmail: string },
): Promise<{ id: string; landlord_id: string } | null> {
  const landlordId = args.landlordId.trim();
  const email = args.prospectEmail.trim().toLowerCase();
  if (!landlordId || !email.includes("@")) return null;

  const select = "id, landlord_id";
  const read = async () => {
    const { data } = await db
      .from("agent_sessions")
      .select(select)
      .eq("kind", SESSION_KIND)
      .eq("landlord_id", landlordId)
      .eq("vendor_phone_e164", email)
      .maybeSingle();
    return (data as { id: string; landlord_id: string } | null) ?? null;
  };

  const existing = await read();
  if (existing) return existing;

  const { data: created, error } = await db
    .from("agent_sessions")
    .insert({
      landlord_id: landlordId,
      user_id: null,
      kind: SESSION_KIND,
      // The conversation key for this kind. Never an E.164 number, so it cannot
      // collide with an SMS prospect's session.
      vendor_phone_e164: email,
      status: "active",
    })
    .select(select)
    .maybeSingle();
  // Race on the unique index — re-read rather than fail the turn.
  if (error) return error.code === "23505" ? read() : null;
  return (created as { id: string; landlord_id: string } | null) ?? null;
}

/** One leasing turn for a prospect who emailed the work address. */
export async function runLeasingEmailAgentTurn(
  db: Db,
  args: {
    landlordId: string;
    prospectEmail: string;
    inboundText: string;
    inboundEmailId: string;
    /** Set for a booking-site guest message: channel-aware prompt, tool allowlist, catalog and post-checks. */
    channel?: LeasingEmailChannel;
  },
): Promise<LeasingEmailTurn | null> {
  const text = args.inboundText.trim();
  if (!text) return null;

  const session = await findOrCreateLeasingEmailSession(db, {
    landlordId: args.landlordId,
    prospectEmail: args.prospectEmail,
  });
  if (!session) return null;

  const nowIso = new Date().toISOString();
  const { error: inboundError } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "user",
    content: text,
    channel: "email",
    // `source_message_sid`, not `external_id`. There has never been an
    // `external_id` column on `agent_messages` — no migration creates one — so
    // every prospect who emailed a manager's work email failed this insert,
    // fell into the `return null` below, and got silence. The whole leasing
    // branch of the work email has been dead since it shipped.
    //
    // This is the column the SMS paths already write, and the one carrying the
    // unique partial index (`source_message_sid is not null and role = 'user'`)
    // that makes the 23505 check below mean something.
    source_message_sid: args.inboundEmailId.trim() || null,
  });
  // A duplicate source id means Resend redelivered — the reply below is still
  // regenerated, but the caller's own claim row is what stops a second send.
  if (inboundError && inboundError.code !== "23505") {
    console.error("leasing-email inbound persistence failed", session.id, inboundError.message);
    return null;
  }

  const { data: historyRows } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", session.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = ((historyRows ?? []) as { role: string; content: string }[])
    .reverse()
    .map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
    })) as Anthropic.MessageParam[];
  if (history.length === 0 || history.at(-1)!.role !== "user") {
    history.push({ role: "user", content: text });
  }

  const ctx = buildLeasingSmsAgentContext(db, {
    landlordId: session.landlord_id,
    scope: {
      sessionId: session.id,
      prospectPhoneE164: "",
      // A channel guest has no email of their own (the key address is internal): nothing may prefill or quote it.
      prospectEmail: args.channel ? null : args.prospectEmail.trim().toLowerCase(),
      channel: "email",
      currentInboundText: text,
      workNumber: null,
      crossCatalog: false,
      ...(args.channel?.serviceWorkspace ? { serviceCatalog: true } : {}),
    },
  });

  let traceId: string | null = null;
  let result;
  try {
    // The manager who owns the mailbox, resolved before this call — never
    // supplied by the prospect.
    const system =
      (await leasingSmsSystemPromptForWorkNumberOwner(db, session.landlord_id)) +
      (args.channel
        ? channelAgentInstructions({
            site: args.channel.site,
            siteLabel: CHANNEL_SITE_LABEL[args.channel.site],
            guestName: args.channel.guestName,
            listingLine: args.channel.listingLine,
            holdReason: args.channel.holdReason,
            serviceWorkspace: args.channel.serviceWorkspace,
            proplaneLine: args.channel.proplaneLine,
          })
        : EMAIL_CHANNEL_INSTRUCTIONS);
    result = await traceAgentTurn(
      leasingSmsTraceActor(session.landlord_id),
      history as { role: string; content: string }[],
      (observer) =>
        runAgentTurn({
          ctx,
          registry: args.channel ? channelLeasingRegistry(args.channel.site) : leasingSmsAgentRegistry,
          messages: history,
          observer,
          system,
          model: runtimeTaskModel(),
          readOnly: true,
          allowWriteTools: args.channel ? channelInlineWriteTools(args.channel.site) : LEASING_SMS_INLINE_WRITE_TOOLS,
        }),
      {
        name: "axis-leasing-email-turn",
        sessionId: session.id,
        promptMeta: resolvePromptMeta(PROMPT_IDS.leasingSmsAgent, system),
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
  } catch (e) {
    console.error("leasing-email agent turn failed", session.id, e);
    return null;
  }

  let reply = result.reply.trim();
  if (!reply) return null;

  /* Channel post-checks, on the TEXT the model wrote (the prompt is a request, this is the guarantee): availability
     only from a checked read, and no contact details on a site that forbids them. */
  let channelResult: LeasingEmailTurn["channel"];
  if (args.channel) {
    const checked = enforceCheckedAvailability({ reply, toolEvidence: result.toolEvidence });
    reply = checked.reply;
    channelResult = {
      availabilityReplaced: checked.replaced,
      violations: channelReplyViolations(args.channel.site, reply, { allowedPhoneDigits: args.channel.proplaneLine }),
    };
  }

  await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "assistant",
    content: reply,
    channel: "agent",
    tool_trace: result.toolTrace,
    trace_id: traceId,
  });
  await db.from("agent_sessions").update({ updated_at: nowIso }).eq("id", session.id);
  track("leasing_email_message_out", session.landlord_id, { tools: result.toolTrace.length });

  return { reply, sessionId: session.id, traceId, ...(channelResult ? { channel: channelResult } : {}) };
}
