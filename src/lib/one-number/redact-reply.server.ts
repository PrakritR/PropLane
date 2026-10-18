import "server-only";

import { SECURE_PAYMENT_REPLY } from "@/lib/one-number/redact";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * When an inbound text contained a card or bank number, the webhook redacted it
 * before storing it and stamped `redacted: true` on the receipt's payload. The
 * agent answers the redacted text, but whatever it drafted is NOT what goes
 * out: the sender gets the canned "please do not text card or bank numbers"
 * reply with the secure-link pointer. Returns that reply for such an inbound,
 * else null. Never throws: a read problem means "not redacted".
 */
export async function redactedInboundReplyOverride(
  inboundMessageSid: string | null | undefined,
): Promise<string | null> {
  const sid = String(inboundMessageSid ?? "").trim();
  if (!sid) return null;
  try {
    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("sms_inbound_receipts")
      .select("inbound_payload")
      .eq("message_sid", sid)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const payload = data.inbound_payload as { redacted?: unknown } | null;
    return payload?.redacted === true ? SECURE_PAYMENT_REPLY : null;
  } catch {
    return null;
  }
}
