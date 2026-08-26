/**
 * PropLane SMS transport. The legacy shared Claw line is permanently disabled;
 * active sends use each manager's provisioned Twilio work number.
 */

import { after } from "next/server";
import {
  isClawMessengerConfigured,
  normalizeE164Us,
  registerClawMessengerRoute,
  sendClawMessengerText,
} from "@/lib/claw-messenger.server";
import {
  clawLeasingAgentPhoneE164,
  isClawSharedLineBridgeEnabled,
} from "@/lib/claw-leasing-links";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { quietHoursBlocks, type SmsSendClass } from "@/lib/sms/number-registration-policy";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";

export type { SmsSendClass };

export type PropLaneSmsResult = {
  ok: boolean;
  channel?: "twilio" | "claw";
  sid?: string;
  error?: string;
  /** Durable managed outbox handoff. Once present, the outbox owns retries. */
  outboxId?: string;
  outboxStatus?: string;
  durablyAccepted?: boolean;
};

/**
 * Transport-level consent + quiet-hours gate. Applied to EVERY send regardless
 * of channel (Claw shared line or Twilio work number) so the opt-out ledger can
 * never be bypassed — the ungated Claw path is exactly what got the A2P campaign
 * rejected. `control` messages (STOP/HELP auto-replies) and explicit
 * `skipConsentCheck` (phone-verification OTP) bypass the opt-out check; quiet
 * hours only suppress `automated` traffic (rent reminders, bulk notices).
 * Fails OPEN on infra error so a transient DB blip can't drop all messaging.
 */
async function transportGateBlocks(args: {
  to: string;
  sendClass: SmsSendClass;
  skipConsentCheck?: boolean;
}): Promise<PropLaneSmsResult | null> {
  if (quietHoursBlocks(args.sendClass, new Date())) {
    return { ok: false, error: "quiet_hours" };
  }
  if (args.sendClass === "control" || args.skipConsentCheck) return null;
  try {
    const db = createSupabaseServiceRoleClient();
    if (await isPhoneOptedOut(db, args.to)) {
      return { ok: false, error: "recipient_opted_out" };
    }
  } catch {
    /* fail open */
  }
  return null;
}

function normalizeTo(raw: string): string | null {
  return normalizeE164Us(raw) ?? normalizeE164(raw);
}

async function logOutboundIfNeeded(args: {
  log?: {
    managerUserId: string;
    residentUserId?: string | null;
    residentEmail?: string | null;
    residentPhone?: string | null;
    source?: "work_number" | "relay" | "automated";
    counterpartyRole?: import("@/lib/sms-conversation-identity").SmsCounterpartyRole;
  } | null;
  to: string;
  text: string;
  fromPhone: string | null;
  messageSid?: string | null;
}): Promise<void> {
  if (!args.log?.managerUserId) return;
  try {
    const db = createSupabaseServiceRoleClient();
    const { logManagerSmsMessage } = await import("@/lib/manager-sms-messages.server");
    await logManagerSmsMessage(db, {
      managerUserId: args.log.managerUserId,
      residentUserId: args.log.residentUserId,
      residentPhone: args.log.residentPhone ?? args.to,
      direction: "outbound",
      body: args.text,
      fromPhone: args.fromPhone,
      toPhone: args.to,
      messageSid: args.messageSid ?? null,
      source: args.log.source ?? "work_number",
      counterpartyRole: args.log.counterpartyRole,
    });
  } catch (e) {
    console.error("logOutboundIfNeeded failed", e instanceof Error ? e.message : e);
  }
}

/** True when Claw Messenger is configured for PropLane messaging. */
export function isClawTransportEnabled(): boolean {
  // SMS_RUNTIME_ENABLED is the deliberate managed-Twilio cutover. Once it is
  // on, no manager-owned message may fall back to the legacy shared transport.
  return process.env.SMS_RUNTIME_ENABLED?.trim() !== "1" && isClawMessengerConfigured();
}

/**
 * Send an SMS. Claw-primary: always send via the shared agent line.
 * Twilio is only attempted when Claw is disabled (future per-manager numbers).
 */
export async function sendPropLaneSms(args: {
  to: string;
  text: string;
  fromNumber?: string | null;
  /** Traffic class for the consent + quiet-hours gate (default transactional). */
  sendClass?: SmsSendClass;
  /** Bypass the opt-out check (compliance/verification only). */
  skipConsentCheck?: boolean;
  purpose?: string;
  conversationKey?: string | null;
  dedupeKey?: string | null;
  actorUserId?: string | null;
  traceId?: string | null;
  /**
   * When set, logs outbound SMS for the Communication → SMS → Sent tab.
   * Pass `null` to skip (e.g. manager carbon-copy mirrors).
   */
  log?: {
    managerUserId: string;
    residentUserId?: string | null;
    residentEmail?: string | null;
    residentPhone?: string | null;
    source?: "work_number" | "relay" | "automated";
    counterpartyRole?: import("@/lib/sms-conversation-identity").SmsCounterpartyRole;
  } | null;
}): Promise<PropLaneSmsResult> {
  const text = args.text.trim();
  if (!text) return { ok: false, error: "empty_body" };
  const to = normalizeTo(args.to);
  if (!to) return { ok: false, error: "invalid_to" };

  // Consent + quiet-hours gate — every channel, never bypassed.
  const blocked = await transportGateBlocks({
    to,
    sendClass: args.sendClass ?? "transactional",
    skipConsentCheck: args.skipConsentCheck,
  });
  if (blocked) return blocked;

  // Claw-primary: one agent line runs the entire messaging system.
  if (isClawTransportEnabled()) {
    const from = clawLeasingAgentPhoneE164();
    await registerClawMessengerRoute(to);
    const claw = await sendClawMessengerText({ to, text });
    if (claw.ok) {
      await logOutboundIfNeeded({
        log: args.log,
        to,
        text,
        fromPhone: from,
        messageSid: claw.messageId,
      });
    }
    return {
      ok: claw.ok,
      channel: claw.ok ? "claw" : undefined,
      sid: claw.messageId,
      error: claw.ok ? undefined : claw.error,
    };
  }

  // Managed Twilio has exactly one send choke point. A caller without an
  // owner-scoped log identity (platform alerts, old direct transports) is not
  // allowed to borrow a manager number.
  const managerUserId = args.log?.managerUserId?.trim();
  if (!managerUserId) return { ok: false, error: "managed_sender_scope_required" };
  const sendClass = args.sendClass ?? "transactional";
  if (args.skipConsentCheck && sendClass !== "control") {
    return { ok: false, error: "managed_consent_bypass_forbidden" };
  }
  const role = args.log?.counterpartyRole ?? (args.log?.residentUserId ? "resident" : "unknown");
  const conversationKey = args.conversationKey ?? buildConversationKey({
    ownerManagerUserId: managerUserId,
    role,
    counterpartyUserId: args.log?.residentUserId,
    counterpartyPhone: to,
  });
  const db = createSupabaseServiceRoleClient();
  const { enqueueOwnerSms, dispatchOwnerSmsOutbox } = await import(
    "@/lib/sms/owner-sms-dispatcher.server"
  );
  const enqueued = await enqueueOwnerSms({
    managerUserId,
    actorUserId: args.actorUserId?.trim() || managerUserId,
    recipientPhone: to,
    recipientUserId: args.log?.residentUserId ?? null,
    recipientEmail: args.log?.residentEmail ?? null,
    body: text,
    sendClass,
    purpose: args.purpose?.trim() || (sendClass === "automated" ? "legacy_automated_message" : "manager_conversation"),
    conversationKey,
    counterpartyRole: role,
    dedupeKey: args.dedupeKey,
    traceId: args.traceId,
  }, db);
  if (!enqueued.ok) return { ok: false, channel: "twilio", error: enqueued.error };
  await dispatchOwnerSmsOutbox({
    workerId: `compat-${managerUserId}`,
    outboxId: enqueued.outboxId,
  }, db);
  const { data: outbox } = await db
    .from("sms_outbox")
    .select("status, provider_message_sid, blocked_reason")
    .eq("id", enqueued.outboxId)
    .maybeSingle();
  const submitted = ["submitted", "sent", "delivered"].includes(String(outbox?.status ?? ""));
  return submitted
    ? {
        ok: true,
        channel: "twilio",
        sid: String(outbox?.provider_message_sid ?? "") || undefined,
        outboxId: enqueued.outboxId,
        outboxStatus: String(outbox?.status ?? enqueued.status),
        durablyAccepted: true,
      }
    : {
        ok: false,
        channel: "twilio",
        error: String(outbox?.blocked_reason ?? outbox?.status ?? "queued"),
        outboxId: enqueued.outboxId,
        outboxStatus: String(outbox?.status ?? enqueued.status),
        durablyAccepted: true,
      };
}

/**
 * Send from the PropLane messaging number for this manager.
 * Under Claw-primary that is always the shared agent line.
 */
export async function sendFromManagerWorkNumber(args: {
  managerUserId: string;
  to: string;
  text: string;
  /** When already known (inbound webhook), skip the profile lookup. */
  fromNumber?: string | null;
  residentUserId?: string | null;
  residentEmail?: string | null;
  source?: "work_number" | "relay" | "automated";
  /** Traffic class for the consent + quiet-hours gate (default transactional). */
  sendClass?: SmsSendClass;
  /** The recipient's capacity, so outbound threads under the same
   * conversation identity as their inbound (resident vs prospect). */
  counterpartyRole?: import("@/lib/sms-conversation-identity").SmsCounterpartyRole;
  conversationKey?: string | null;
  dedupeKey?: string | null;
  purpose?: string;
  actorUserId?: string | null;
  traceId?: string | null;
  /** Skip Communication → SMS Sent logging (manager mirror copies). */
  skipLog?: boolean;
}): Promise<PropLaneSmsResult> {
  const managerUserId = args.managerUserId.trim();
  if (!managerUserId) return { ok: false, error: "missing_manager" };

  let from: string | null = null;
  if (isClawTransportEnabled() || isClawSharedLineBridgeEnabled()) {
    from = clawLeasingAgentPhoneE164();
  }

  return sendPropLaneSms({
    to: args.to,
    text: args.text,
    fromNumber: from,
    sendClass: args.sendClass,
    purpose: args.purpose ?? (args.sendClass === "automated" ? "legacy_automated_message" : "manager_conversation"),
    conversationKey: args.conversationKey,
    dedupeKey: args.dedupeKey,
    actorUserId: args.actorUserId,
    traceId: args.traceId,
    log: args.skipLog
      ? null
      : {
          managerUserId,
          residentUserId: args.residentUserId,
          residentEmail: args.residentEmail,
          residentPhone: args.to,
          source: args.source ?? "work_number",
          counterpartyRole: args.counterpartyRole,
        },
  });
}

/**
 * Seed the local state row after signup. Real Twilio provisioning is explicit
 * from Settings → Messaging and is never triggered by onboarding or reads.
 */
export function scheduleManagerMessagingReady(managerUserId: string): void {
  const uid = managerUserId.trim();
  if (!uid) return;

  const run = async () => {
    try {
      const db = createSupabaseServiceRoleClient();
      // Every manager gets a provisioning record at signup — parked in
      // `pending_registration` (no purchase, no cost) until an operator enables
      // provisioning and the manager's registration is approved.
      const { ensureManagerNumberRecord } = await import(
        "@/lib/sms/manager-number-provisioning.server"
      );
      await ensureManagerNumberRecord(db, uid);

      if (
        process.env.SMS_RUNTIME_ENABLED?.trim() !== "1" &&
        (isClawSharedLineBridgeEnabled() || isClawTransportEnabled())
      ) {
        const agent = clawLeasingAgentPhoneE164();
        await db
          .from("profiles")
          .update({ sms_from_number: agent, updated_at: new Date().toISOString() })
          .eq("id", uid);
        return;
      }
    } catch (e) {
      console.error("scheduleManagerMessagingReady failed", uid, e);
    }
  };

  try {
    after(() => void run());
  } catch {
    void run();
  }
}
