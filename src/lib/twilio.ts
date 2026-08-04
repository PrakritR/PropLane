import twilio from "twilio";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/phone-e164";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

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
  opts?: { skipOptOutCheck?: boolean; mediaUrls?: string[] },
): Promise<{ sent: boolean; sid?: string; error?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return { sent: false };

  const toNorm = normalizeE164(to);
  const fromNorm = normalizeE164(fromNumber);
  if (!toNorm || !fromNorm) return { sent: false, error: `Cannot normalize phone: to=${to} from=${fromNumber}` };

  // Consent gate (single choke point): never text a number that has opted out
  // via STOP. Only compliance/verification messages (`skipOptOutCheck`) bypass —
  // e.g. the phone-verification OTP, where the user is actively re-opting in.
  // Fails open on infra error so a transient DB blip can't drop all messaging.
  if (!opts?.skipOptOutCheck) {
    try {
      const db = createSupabaseServiceRoleClient();
      if (await isPhoneOptedOut(db, toNorm)) {
        return { sent: false, error: "recipient_opted_out" };
      }
    } catch {
      // ignore — proceed to send
    }
  }

  // Paid-feature gate (same choke-point idea as consent): a per-manager work
  // number belongs to an actively-paid Pro/Business account (or a deliberately
  // enabled one). When `from` is such a number and its owner's access is
  // suspended — downgraded to Free, trial not converted — the number keeps
  // existing but stops sending. Unowned froms (shared agent line, relay pool,
  // TWILIO_DEFAULT_FROM) pass through untouched. Fails open on infra error.
  try {
    const db = createSupabaseServiceRoleClient();
    const { resolveWorkNumberOwnerAccess, sendAllowedByAccess } = await import(
      "@/lib/sms/manager-number-access.server"
    );
    const owner = await resolveWorkNumberOwnerAccess(db, fromNorm);
    if (owner && !sendAllowedByAccess(owner.decision)) {
      return { sent: false, error: "number_suspended" };
    }
  } catch {
    // ignore — proceed to send
  }

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL?.trim();

  try {
    const client = twilio(accountSid, authToken);
    const message = await client.messages.create({
      to: toNorm,
      from: fromNorm,
      body,
      ...(opts?.mediaUrls?.length ? { mediaUrl: opts.mediaUrls.slice(0, 10) } : {}),
      ...(messagingServiceSid ? { messagingServiceSid } : {}),
      ...(statusCallback ? { statusCallback } : {}),
    });
    return { sent: true, sid: message.sid };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}
