import "server-only";

import { SHARED_LINE_OTP_RULES } from "@/lib/one-number/contracts";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendSms } from "@/lib/twilio";

/** Shared-mode hooks may send only against the app's atomic, rate-limited reservation. */
export async function claimPhoneAuthHookDelivery(phone: string): Promise<boolean> {
  try {
    const db = createSupabaseServiceRoleClient();
    if ((await loadSharedLineConfig(db)).mode !== "shared") return true;
    const { data, error } = await db.rpc("phone_auth_claim_hook_delivery", { p_phone: phone });
    // A missing migration, a duplicate hook, or an unsolicited GoTrue request
    // has no delivery authority. Never fall back to an unbudgeted send.
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * Auth codes are platform traffic, never billed to or sent from a workspace.
 * Both the signed Supabase hook and the local challenge flow use this path.
 * No payload or provider error is logged: either may contain the code/phone.
 */
export async function sendPhoneAuthCode(phone: string, code: string, actorUserId?: string): Promise<boolean> {
  const to = normalizeE164(phone);
  if (!to || !new RegExp(`^\\d{${SHARED_LINE_OTP_RULES.codeLength}}$`).test(code)) return false;

  try {
    const config = await loadSharedLineConfig(createSupabaseServiceRoleClient());
    const from = config.mode === "shared"
      ? config.sharedNumber
      : normalizeE164(process.env.TWILIO_DEFAULT_FROM);
    if (!from) return false;

    const result = await sendSms(
      to,
      `Your PropLane code is ${code}. It expires in ${SHARED_LINE_OTP_RULES.ttlMinutes} minutes. Do not share this code.`,
      from,
      {
        purpose: "phone_verification", skipOptOutCheck: true,
        ...(config.mode === "shared" ? { messagingServiceSid: config.messagingServiceSid } : {}),
        ...(actorUserId ? { actorUserId } : {}),
      },
    );
    return result.sent;
  } catch {
    return false;
  }
}
