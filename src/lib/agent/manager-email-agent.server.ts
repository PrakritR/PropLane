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
  toEmail: string;
  subject: string;
  text: string;
  fromAddress: string;
  replyTo?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "Email delivery not configured." };

  const to = args.toEmail.trim().toLowerCase();
  if (!to.includes("@")) return { ok: false, error: "Invalid recipient." };

  const from = args.fromAddress.includes("<")
    ? args.fromAddress
    : `PropLane Assistant <${args.fromAddress.trim().toLowerCase()}>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: args.subject.trim() || "PropLane Assistant",
      text: args.text,
      ...(args.replyTo?.trim() ? { reply_to: args.replyTo.trim() } : {}),
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) return { ok: false, error: payload.message ?? "Email send failed." };
  return { ok: true };
}
