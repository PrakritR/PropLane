/**
 * The manager SMS agent: a verified manager or co-manager texts a PropLane
 * work number and gets the manager portal's assistant back. Scope follows
 * `ctx.managerSmsAccess` (owner / combined / delegated).
 *
 * This replaced two things that both had to go:
 *
 *  - A blind relay. `detectManagerSelfReply` used to forward whatever the
 *    manager typed to their MOST RECENT resident thread, chosen by recency
 *    alone. Leg 1 mirroring may show them A forwarded text, but never which
 *    thread a bare reply lands in: with two conversations moving, "on my way"
 *    went to whoever wrote last. Contacting a resident is now an explicit
 *    proposal (`send_message` / `reply_to_thread`) naming the recipient,
 *    confirmed by YES.
 *  - A four-intent regex (`claw-manager-actions.server.ts`) whose `mark paid`
 *    wrote `portal_household_charge_records` directly with the service-role
 *    client: no tool layer, no preview, no confirmation. Both AGENTS.md
 *    invariants, broken on the money path.
 *
 * The turn body is `sms-agent-turn.server.ts`, shared with the resident SMS
 * agent. What is specific here:
 *
 *  - Identity is `resolveManagerSmsAgentContext`, called ONLY after
 *    `resolveManagerSmsInboundIdentity` has matched the work number's owner
 *    against a verified manager or co-manager phone. This module never
 *    resolves identity itself.
 *  - The registry is `buildManagerSmsRegistry()` — the portal catalog minus
 *    every destructive tool. See its doc comment for why.
 *  - `MANAGER_INLINE_WRITE_TOOLS` stays allow-listed, exactly as on the portal
 *    chat route: inbox housekeeping a manager would find absurd to confirm one
 *    card at a time, audit-logged by its own handler.
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

export type ManagerSmsTurn = SmsAgentTurn;

const MANAGER_SMS_SURFACE: SmsAgentSurface = {
  sessionKind: "manager_sms",
  portal: "manager",
  basePrompt: MANAGER_SMS_AGENT_SYSTEM_PROMPT,
  promptId: PROMPT_IDS.managerSmsAgent,
  traceName: "manager-sms-agent-turn",
  analytics: {
    messageIn: "manager_sms_message_in",
    messageOut: "manager_sms_message_out",
    actionProposed: "manager_sms_action_proposed",
  },
  allowWriteTools: MANAGER_INLINE_WRITE_TOOLS,
};

/** ID-only Langfuse attribution; never include the manager phone or message. */
export function managerSmsTraceActor(ctx: AgentContext): TraceActor {
  return {
    userId: ctx.userId,
    metadata: {
      landlordId: ctx.landlordId,
      role: "manager",
      managerIds: [...new Set([ctx.landlordId, ctx.userId])],
      activeManagerId: ctx.landlordId,
      channel: "sms",
      smsAccessMode: ctx.managerSmsAccess?.mode ?? "owner",
    },
  };
}

/**
 * Run one manager-SMS turn. Returns null when suppressed (no API key, empty
 * body, hourly cap) so the caller can stay silent rather than send filler.
 *
 * `ctx` must come from `resolveManagerSmsAgentContext`, itself gated on
 * `resolveManagerSmsInboundIdentity`. A context built any other way hands an
 * unverified texter a whole portfolio.
 */
export async function runManagerSmsAgentTurn(
  db: Db,
  args: {
    ctx: AgentContext;
    managerPhoneE164: string;
    inboundText: string;
    inboundMessageSid?: string | null;
  },
): Promise<ManagerSmsTurn | null> {
  const access = args.ctx.managerSmsAccess;
  const scopeNote = access ? managerSmsScopePrompt(access) : "";
  const surface: SmsAgentSurface = scopeNote
    ? { ...MANAGER_SMS_SURFACE, basePrompt: `${MANAGER_SMS_AGENT_SYSTEM_PROMPT}\n\n${scopeNote}` }
    : MANAGER_SMS_SURFACE;
  return runSmsAgentTurn<AgentContext>(db, {
    ctx: args.ctx,
    surface,
    registry: buildManagerSmsRegistry(access),
    sessionLandlordId: args.ctx.landlordId,
    phoneE164: args.managerPhoneE164,
    inboundText: args.inboundText,
    inboundMessageSid: args.inboundMessageSid,
    traceActor: managerSmsTraceActor(args.ctx),
    traceMetadata: {
      landlordId: args.ctx.landlordId,
      role: "manager",
      managerIds: [...new Set([args.ctx.landlordId, args.ctx.userId])],
      activeManagerId: args.ctx.landlordId,
      channel: "sms",
      smsAccessMode: access?.mode ?? "owner",
    },
  });
}

/**
 * Send the manager agent's reply back to the manager's own cell, from their
 * work number.
 *
 * The conversation key uses role `manager` with the manager as their own
 * counterparty, so this assistant thread is structurally distinct from every
 * resident/prospect thread on the same number and can never merge with one.
 */
export async function deliverManagerSmsReply(args: {
  managerUserId: string;
  toPhone: string;
  text: string;
  workNumber?: string | null;
  inboundMessageSid?: string | null;
  traceId?: string | null;
  actorUserId?: string;
}): Promise<import("@/lib/proplane-sms-transport.server").PropLaneSmsResult> {
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const { buildConversationKey } = await import("@/lib/sms-conversation-identity");
  const actorUserId = (args.actorUserId ?? args.managerUserId).trim() || args.managerUserId;
  return sendFromManagerWorkNumber({
    managerUserId: args.managerUserId,
    to: args.toPhone,
    text: args.text,
    fromNumber: args.workNumber,
    source: "automated",
    counterpartyRole: "manager",
    conversationKey: buildConversationKey({
      ownerManagerUserId: args.managerUserId,
      role: "manager",
      counterpartyUserId: actorUserId,
      counterpartyPhone: args.toPhone,
    }),
    dedupeKey: args.inboundMessageSid?.trim()
      ? `inbound_reply_${args.inboundMessageSid.trim()}`
      : null,
    purpose: "manager_conversation",
    actorUserId,
    traceId: args.traceId,
  });
}
