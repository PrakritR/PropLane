/**
 * PropLane SMS transport — Claw Messenger is the production source of truth
 * (one shared agent line). Twilio is a future per-manager endeavour and is
 * only used when Claw is explicitly disabled.
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
  managerContactSmsPhoneForPublicCta,
} from "@/lib/claw-leasing-links";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { quietHoursBlocks, type SmsSendClass } from "@/lib/sms/number-registration-policy";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164, sendSms } from "@/lib/twilio";

export type { SmsSendClass };

export type PropLaneSmsResult = {
  ok: boolean;
  channel?: "twilio" | "claw";
  sid?: string;
  error?: string;
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
  return isClawMessengerConfigured();
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
  /**
   * When set, logs outbound SMS for the Communication → SMS → Sent tab.
   * Pass `null` to skip (e.g. manager carbon-copy mirrors).
   */
  log?: {
    managerUserId: string;
    residentUserId?: string | null;
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

  // Future Twilio path (Claw disabled).
  const from = managerContactSmsPhoneForPublicCta(args.fromNumber);
  if (from) {
    // Consent already enforced by the transport gate above — don't re-gate (it
    // would wrongly block control/skipConsentCheck sends the gate cleared).
    const twilio = await sendSms(to, text, from, { skipOptOutCheck: true });
    if (twilio.sent) {
      await logOutboundIfNeeded({
        log: args.log,
        to,
        text,
        fromPhone: from,
        messageSid: twilio.sid,
      });
      return { ok: true, channel: "twilio", sid: twilio.sid };
    }
    return { ok: false, channel: "twilio", error: twilio.error || "twilio_send_failed" };
  }

  return { ok: false, error: "missing_from" };
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
  source?: "work_number" | "relay" | "automated";
  /** Traffic class for the consent + quiet-hours gate (default transactional). */
  sendClass?: SmsSendClass;
  /** The recipient's capacity, so outbound threads under the same
   * conversation identity as their inbound (resident vs prospect). */
  counterpartyRole?: import("@/lib/sms-conversation-identity").SmsCounterpartyRole;
  /** Skip Communication → SMS Sent logging (manager mirror copies). */
  skipLog?: boolean;
}): Promise<PropLaneSmsResult> {
  const managerUserId = args.managerUserId.trim();
  if (!managerUserId) return { ok: false, error: "missing_manager" };

  let from: string | null = null;
  if (isClawTransportEnabled() || isClawSharedLineBridgeEnabled()) {
    from = clawLeasingAgentPhoneE164();
  } else {
    from = managerContactSmsPhoneForPublicCta(args.fromNumber);
    if (!from) {
      try {
        const db = createSupabaseServiceRoleClient();
        // Prefer the manager's OWN registration-approved number (ISV model): a
        // number can exist but stay unable to send until that manager's own
        // registration clears, in which case this returns null and we fall back.
        const { resolveManagerSendNumberState } = await import(
          "@/lib/sms/manager-number-provisioning.server"
        );
        const state = await resolveManagerSendNumberState(db, managerUserId);
        // A suspended account owns that number — every fallback below would
        // resolve to the SAME number, so stop here instead of pretending it is
        // an unprovisioned manager (which would also try to BUY one).
        if (state.status === "suspended") return { ok: false, error: "number_suspended" };
        from = managerContactSmsPhoneForPublicCta(
          state.status === "ok" ? state.phoneNumber : null,
        );
        if (!from) {
          const { data } = await db
            .from("profiles")
            .select("sms_from_number")
            .eq("id", managerUserId)
            .maybeSingle();
          const raw = String(data?.sms_from_number ?? "").trim();
          from = managerContactSmsPhoneForPublicCta(raw);
        }
        if (!from) {
          const { ensureManagerSmsNumber } = await import("@/lib/twilio-provisioning");
          const provisioned = await ensureManagerSmsNumber(db, managerUserId);
          if (provisioned.ok) from = managerContactSmsPhoneForPublicCta(provisioned.number);
        }
      } catch {
        from = null;
      }
    }
  }

  return sendPropLaneSms({
    to: args.to,
    text: args.text,
    fromNumber: from,
    sendClass: args.sendClass,
    log: args.skipLog
      ? null
      : {
          managerUserId,
          residentUserId: args.residentUserId,
          residentPhone: args.to,
          source: args.source ?? "work_number",
          counterpartyRole: args.counterpartyRole,
        },
  });
}

/**
 * Stamp the shared Claw agent line on the manager (Claw-primary), or buy a
 * Twilio work number when Claw is off (future).
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
      const { ensureManagerNumberRecord, provisionManagerNumber } = await import(
        "@/lib/sms/manager-number-provisioning.server"
      );
      await ensureManagerNumberRecord(db, uid);

      if (isClawSharedLineBridgeEnabled() || isClawTransportEnabled()) {
        const agent = clawLeasingAgentPhoneE164();
        await db
          .from("profiles")
          .update({ sms_from_number: agent, updated_at: new Date().toISOString() })
          .eq("id", uid);
        return;
      }
      // Money-guarded: only actually buys when SMS_PROVISIONING_ENABLED=1.
      await provisionManagerNumber(db, uid);
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
