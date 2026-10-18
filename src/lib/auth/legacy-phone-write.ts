import { normalizeE164 } from "@/lib/phone-e164";

export const VERIFIED_PHONE_CHANGE_MESSAGE = "Verify your phone to continue.";
export const PHONE_VERIFICATION_PATH = "/auth/verify-phone";

/** Legacy contact forms cannot change a shared-line login credential. */
export function legacyPhoneWriteDecision(
  current: { phone?: unknown; phone_verified_at?: unknown } | null | undefined,
  requested: string | null,
  shared: boolean,
): { blocked: boolean; phone: string | null; clearVerification: boolean } {
  const saved = typeof current?.phone === "string" ? current.phone : null;
  const same = saved === requested || Boolean(normalizeE164(saved) && normalizeE164(saved) === normalizeE164(requested));
  const verified = Boolean(current?.phone_verified_at);
  return {
    blocked: shared && verified && !same,
    phone: shared && verified && same ? saved : requested,
    clearVerification: shared && !verified && saved !== requested,
  };
}
