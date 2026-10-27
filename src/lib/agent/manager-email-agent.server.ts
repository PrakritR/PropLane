/**
 * Manager email assistant — same agent catalog and confirmation gate as manager
 * SMS, delivered over email when a manager messages their PropLane assistant address.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildManagerSmsRegistry, MANAGER_INLINE_WRITE_TOOLS } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";
import { PROMPT_IDS } from "@/lib/agent/prompt-metadata";
import { MANAGER_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { managerSmsScopePrompt } from "@/lib/sms/manager-sms-access";
import type { TraceActor } from "@/lib/observability/langfuse";
import {
  runSmsAgentTurn,
  type SmsAgentSurface,
  type SmsAgentTurn,
} from "@/lib/agent/sms-agent-turn.server";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { assertManagerCommunicationAllowed } from "@/lib/manager-communication-access.server";
import { isChannelRelayAddress, singleEmailAddress, type ChannelSite } from "@/lib/inbound-email/channel-senders";

type Db = SupabaseClient;

export type ManagerEmailTurn = SmsAgentTurn;

const MANAGER_EMAIL_SURFACE: SmsAgentSurface = {
  sessionKind: "manager_email",
  portal: "manager",
  basePrompt: MANAGER_SMS_AGENT_SYSTEM_PROMPT,
  promptId: PROMPT_IDS.managerSmsAgent,
  traceName: "manager-email-agent-turn",
  analytics: {
    messageIn: "manager_email_message_in",
    messageOut: "manager_email_message_out",
    actionProposed: "manager_email_action_proposed",
  },
  allowWriteTools: MANAGER_INLINE_WRITE_TOOLS,
  maxReplyChars: 4000,
};

export function managerEmailTraceActor(ctx: AgentContext): TraceActor {
  return {
    userId: ctx.userId,
    metadata: {
      landlordId: ctx.landlordId,
      role: "manager",
      managerIds: [...new Set([ctx.landlordId, ctx.userId])],
      activeManagerId: ctx.landlordId,
      channel: "email",
      smsAccessMode: ctx.managerSmsAccess?.mode ?? "owner",
    },
  };
}

export async function runManagerEmailAgentTurn(
  db: Db,
  args: {
    ctx: AgentContext;
    actorEmail: string;
    inboundText: string;
    inboundEmailId?: string | null;
  },
): Promise<ManagerEmailTurn | null> {
  const access = args.ctx.managerSmsAccess;
  const scopeNote = access ? managerSmsScopePrompt(access) : "";
  const surface: SmsAgentSurface = scopeNote
    ? { ...MANAGER_EMAIL_SURFACE, basePrompt: `${MANAGER_SMS_AGENT_SYSTEM_PROMPT}\n\n${scopeNote}` }
    : MANAGER_EMAIL_SURFACE;
  return runSmsAgentTurn<AgentContext>(db, {
    ctx: args.ctx,
    surface,
    registry: buildManagerSmsRegistry(access),
    sessionLandlordId: args.ctx.landlordId,
    phoneE164: args.actorEmail.trim().toLowerCase(),
    inboundText: args.inboundText,
    inboundMessageSid: args.inboundEmailId?.trim() || null,
    traceActor: managerEmailTraceActor(args.ctx),
    traceMetadata: {
      landlordId: args.ctx.landlordId,
      role: "manager",
      managerIds: [...new Set([args.ctx.landlordId, args.ctx.userId])],
      activeManagerId: args.ctx.landlordId,
      channel: "email",
      smsAccessMode: access?.mode ?? "owner",
    },
  });
}

export async function deliverManagerEmailReply(args: {
  managerUserId: string;
  toEmail: string;
  subject: string;
  text: string;
  fromAddress: string;
  replyTo?: string | null;
  /**
   * A reply to a booking-site guest message. `toEmail` must then be the site's RELAY address on the site's own domain, and
   * the inbound must have been authenticated (DKIM/SPF) as that site: anything else is refused here, so no caller can
   * route a guest reply to an address a forged mail named.
   */
  channel?: { site: ChannelSite; authenticated: boolean };
}): Promise<{ ok: boolean; error?: string }> {
  if (args.channel) {
    if (!args.channel.authenticated) return { ok: false, error: "The sender was not authenticated as the site." };
    // One strict address on the site's own domain; a list that merely ends in one is refused before anything is sent.
    if (!isChannelRelayAddress(args.channel.site, args.toEmail)) return { ok: false, error: "Not the site's reply address." };
  }
  // A live signup trial has no Communication until it pays; an unreadable plan fails closed.
  const access = await assertManagerCommunicationAllowed(args.managerUserId);
  if (!access.allowed) return { ok: false, error: access.message };

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "Email delivery not configured." };

  const to = (args.channel ? singleEmailAddress(args.toEmail) : args.toEmail.trim().toLowerCase()) ?? "";
  if (!to.includes("@")) return { ok: false, error: "Invalid recipient." };

  const from = args.fromAddress.includes("<")
    ? args.fromAddress
    : `PropLane Assistant <${args.fromAddress.trim().toLowerCase()}>`;

  const res = await postResendEmail({
    apiKey,
    actorUserId: args.managerUserId,
    effectSummary: "Manager assistant email reply captured for the test workspace.",
    payload: {
      from,
      to: [to],
      subject: args.subject.trim() || "PropLane Assistant",
      text: args.text,
      ...(args.replyTo?.trim() ? { reply_to: args.replyTo.trim() } : {}),
    },
  });
  const payload = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) return { ok: false, error: payload.message ?? "Email send failed." };
  return { ok: true };
}
