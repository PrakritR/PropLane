import { normalizeE164 } from "@/lib/phone-e164";

export type PublicTextingConfig = { phone: string | null; smsHref: string | null };
export const SMS_DEMO_BODY = "Hi PropLane, show me the demo";

/** The empty query prefix supports both iOS's &body and standard SMS query parsers. */
export function publicTextingConfig(phone: unknown): PublicTextingConfig {
  const normalized = normalizeE164(phone);
  return normalized
    ? { phone: normalized, smsHref: `sms:${normalized}?&body=${encodeURIComponent(SMS_DEMO_BODY)}` }
    : { phone: null, smsHref: null };
}
