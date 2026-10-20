import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, isSharedLineNumber } from "@/lib/one-number/config.server";
import { handleSmsSignupText } from "@/lib/one-number/signup/flow.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPropLaneServiceLine } from "@/lib/service/service-catalog.server";
import { readScopedSmsConsentState, readSmsSuppressionState, recordScopedSmsConsent } from "@/lib/sms-consent";
import { buildConversationKey } from "@/lib/sms-conversation-identity";

/**
 * The inbound pipeline's sign-up branch for the PropLane line (`on/smssignup`). One call from `inbound-pipeline.server.ts`,
 * ahead of the vendor branch and the leasing fallback, so "I want to sign up as a manager" starts an account instead of
 * getting the leasing agent's "learn about PropLane" reply, and a sign-up in progress (name, business, the code echo) is
 * never read as a prospect or a vendor text.
 *
 * The line is the platform service owner's own number in `per_workspace` mode. On the shared number the router's
 * unknown-sender step runs the same flow (`unknown-sender.server.ts`), so this is `handled: false` there.
 *
 * Nothing here is copied into the owner's Communication thread (`skipLog`): the texts carry a person's name, email and the
 * proof code, and the service owner's team has no business reading them.
 */
export type SignupLineInboundResult = { handled: false } | { handled: true; sent: boolean };

/** The consent purpose of a sign-up thread: the person texted first, which is their own opt-in to replies about it. */
export const SIGNUP_CONVERSATION_PURPOSE = "signup_conversation";
export const SIGNUP_INBOUND_CONSENT_SOURCE = "recipient_initiated_inbound";

async function ensureSignupReplyConsent(
  db: SupabaseClient,
  input: { managerUserId: string; phone: string; messageSid: string; conversationKey: string },
): Promise<"allowed" | "suppressed" | "unavailable"> {
  if (!input.messageSid.trim()) return "unavailable";
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null;
  if (!messagingServiceSid) return "unavailable";
  const suppression = await readSmsSuppressionState(db, input.phone, { userId: null });
  if (!suppression.ok) return "unavailable";
  if (suppression.optedOut) return "suppressed";
  const scope = { managerUserId: input.managerUserId, purpose: SIGNUP_CONVERSATION_PURPOSE, sendClass: "transactional" as const, conversationKey: input.conversationKey, messagingServiceSid };
  const current = await readScopedSmsConsentState(db, input.phone, scope);
  if (!current.ok) return "unavailable";
  if (current.state === "revoked") return "suppressed";
  if (current.state === "granted") return "allowed";
  const recorded = await recordScopedSmsConsent(db, input.phone, {
    ...scope,
    eventType: "granted",
    source: SIGNUP_INBOUND_CONSENT_SOURCE,
    evidence: { messageSid: input.messageSid, role: "signup" },
  });
  return recorded.ok ? "allowed" : "unavailable";
}

export async function handlePropLaneLineSignupInbound(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    workspaceId?: string | null;
    fromPhone: string;
    toPhone: string;
    messageSid: string;
    body: string;
  },
): Promise<SignupLineInboundResult> {
  const phone = normalizeE164(args.fromPhone);
  if (!phone) return { handled: false };
  try {
    const config = await loadSharedLineConfig(db);
    if (isSharedLineNumber(config, args.toPhone)) return { handled: false };
    if (!(await isPropLaneServiceLine(db, { ownerUserId: args.managerUserId, workNumber: args.toPhone, sharedNumber: config.sharedNumber }))) return { handled: false };
  } catch {
    return { handled: false };
  }

  const turn = await handleSmsSignupText(db, { phoneE164: phone, body: args.body, messageSid: args.messageSid });
  if (!turn.handled) return { handled: false };

  const conversationKey = buildConversationKey({ ownerManagerUserId: args.managerUserId, role: "prospect", counterpartyUserId: null, counterpartyPhone: phone });
  const consent = await ensureSignupReplyConsent(db, { managerUserId: args.managerUserId, phone, messageSid: args.messageSid, conversationKey }).catch(() => "unavailable" as const);
  if (consent === "suppressed") return { handled: true, sent: true };
  if (consent === "unavailable") return { handled: true, sent: false };

  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  // Identical replies (a webhook retry) are sent once; a re-issued code is a different text and goes out.
  const dedupeKey = `signup_reply_${args.messageSid}_${createHash("sha256").update(turn.reply).digest("hex").slice(0, 10)}`;
  const sent = await sendFromManagerWorkNumber({
    managerUserId: args.managerUserId,
    to: phone,
    text: turn.reply,
    fromNumber: args.toPhone,
    counterpartyRole: "prospect",
    sendClass: "transactional",
    purpose: SIGNUP_CONVERSATION_PURPOSE,
    conversationKey,
    dedupeKey,
    workspaceId: args.workspaceId ?? null,
    skipLog: true,
  });
  const accepted = sent.ok || Boolean(sent.durablyAccepted);
  if (!accepted) console.error("signup line reply not sent", sent.error ?? "unknown");
  return { handled: true, sent: accepted };
}
