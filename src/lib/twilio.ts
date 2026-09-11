import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/phone-e164";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createTwilioRestClient } from "@/lib/twilio-client.server";

/**
 * Back-compat re-export for the server-side callers that already import it from here.
 * The helper itself lives in `@/lib/phone-e164` because this module pulls in the Twilio
 * SDK and the Supabase service-role client — client components must import it from there.
 */
export { normalizeE164 };

/**
 * Send an SMS via Twilio. Silently skips if env vars aren't configured
 * or if either phone number can't be normalized to E.164.
 *
 * When TWILIO_MESSAGING_SERVICE_SID is set, the message still sends FROM the
 * manager's work number but is attributed to the A2P 10DLC campaign behind that
 * Messaging Service (both `from` and `messagingServiceSid` are passed). When
 * TWILIO_STATUS_CALLBACK_URL is set, Twilio POSTs delivery status there.
 */
export async function sendSms(
  to: string,
  body: string,
  fromNumber: string,
  opts?: { skipOptOutCheck?: boolean; mediaUrls?: string[]; creditReservationKey?: string; purpose?: "phone_verification" },
): Promise<{ sent: boolean; sid?: string; error?: string; providerAttempted?: boolean }> {
  const client = createTwilioRestClient();
  if (!client) return { sent: false, providerAttempted: false };

  const toNorm = normalizeE164(to);
  const fromNorm = normalizeE164(fromNumber);
  if (!toNorm || !fromNorm) return { sent: false, providerAttempted: false, error: `Cannot normalize phone: to=${to} from=${fromNumber}` };

  // Real-customer shield: outside production, never text a number belonging to
  // a protected account. Staging runs on a clone of the production database, so
  // these are real people. Fails closed - see protected-accounts.server.
  const { isShieldedRecipient } = await import("@/lib/protected-accounts.server");
  if (await isShieldedRecipient({ phone: toNorm })) {
    return { sent: false, providerAttempted: false, error: "protected_account_shielded" };
  }

  // Consent gate (single choke point): never text a number that has opted out
  // via STOP. Only compliance/verification messages (`skipOptOutCheck`) bypass —
  // e.g. the phone-verification OTP, where the user is actively re-opting in.
  // Fails open on infra error so a transient DB blip can't drop all messaging.
  if (!opts?.skipOptOutCheck) {
    try {
      const db = createSupabaseServiceRoleClient();
      if (await isPhoneOptedOut(db, toNorm)) {
        return { sent: false, providerAttempted: false, error: "recipient_opted_out" };
      }
    } catch {
      // ignore — proceed to send
    }
  }

  // Manager-funded SMS has one dispatcher. Legacy/shared-number transports
  // cannot bypass its number registration, owner authorization, or prepaid hold.
  // The authenticated, rate-limited phone verification route is the sole exemption.
  if (opts?.purpose !== "phone_verification") {
    if (!opts?.creditReservationKey) return { sent: false, providerAttempted: false, error: "Use the work-number dispatcher to send messages." };
    const db = createSupabaseServiceRoleClient();
    const { data: number, error: numberError } = await db.from("manager_sms_numbers").select("manager_user_id")
      .eq("phone_number", fromNorm).neq("provision_state", "released").maybeSingle();
    const { data: hold, error: creditError } = await db.from("manager_comms_usage_events")
      .select("manager_user_id,meter,quantity,credit_state").eq("idempotency_key", opts.creditReservationKey).maybeSingle();
    if (numberError || creditError || !number || !hold || hold.manager_user_id !== number.manager_user_id || hold.meter !== "sms_outbound_segment"
      || hold.credit_state !== "reserved" || Number(hold.quantity) !== estimateSmsSegments(body).segmentCount) {
      return { sent: false, providerAttempted: false, error: "Communication credit could not be verified." };
    }
  }

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL?.trim();

  try {
    const message = await client.messages.create({
      to: toNorm,
      from: fromNorm,
      body,
      ...(opts?.mediaUrls?.length ? { mediaUrl: opts.mediaUrls.slice(0, 10) } : {}),
      ...(messagingServiceSid ? { messagingServiceSid } : {}),
      ...(statusCallback ? { statusCallback } : {}),
    });
    return { sent: true, sid: message.sid, providerAttempted: true };
  } catch (e) {
    return { sent: false, providerAttempted: true, error: e instanceof Error ? e.message : String(e) };
  }
}
