/**
 * What the phone SIGN-IN door may say out loud (Settings flows keep `PHONE_AUTH_ERROR`).
 *
 * The rule that keeps "a specific error" from becoming "does this number have an account?": a kind is named only when
 * its cause is
 *   - the typed input alone (`bad_number`, `not_us`),
 *   - a setting that is the same for everyone (`off`),
 *   - something that happens identically for any number (`send_failed`, and the per-device/endpoint `throttled`),
 *   - or this browser's own challenge (`wrong_code`, `expired`).
 * Two owners, the per-number lockout and the per-number send cap, and every unreadable / mint / bind failure stay
 * `generic` (an admin account is NOT one of them: it signs in by code like any other account -
 * `docs/agents/one-number.md` DOCUMENTED EXCEPTION).
 * `tests/unit/phone-auth-routes.test.ts` fails if any of those returns a named kind.
 */
export const PHONE_AUTH_ERROR_KINDS = [
  "off", "bad_number", "not_us", "send_failed", "throttled", "wrong_code", "expired", "generic",
] as const;
export type PhoneAuthErrorKind = (typeof PHONE_AUTH_ERROR_KINDS)[number];

export const PHONE_AUTH_COPY: Record<PhoneAuthErrorKind, string> = {
  off: "Phone sign-in isn't available right now. Use Apple, Google or email.",
  bad_number: "Enter a 10-digit phone number.",
  not_us: "We can only text US and Canadian numbers.",
  send_failed: "We couldn't send the text. Try again in a minute.",
  throttled: "Too many codes requested. Try again in an hour, or use Apple, Google or email.",
  wrong_code: "That code didn't match. Check the text and try again.",
  expired: "That code expired.",
  generic: "We couldn't sign you in with this number. Use Apple, Google or email.",
};

/** Shown after an expired code when the server allowed (and the form sent) a fresh one. */
export const PHONE_CODE_EXPIRED_RESENT_COPY = "That code expired. We sent a new one.";

export function isPhoneAuthErrorKind(value: unknown): value is PhoneAuthErrorKind {
  return typeof value === "string" && (PHONE_AUTH_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * Thrown only by the sign-in branches that are allowed to be specific. The message stays the legacy generic text so a
 * caller that does not know about kinds (Settings, logs) behaves exactly as before.
 */
export class PhoneAuthError extends Error {
  readonly kind: PhoneAuthErrorKind;
  constructor(kind: PhoneAuthErrorKind, message: string) {
    super(message);
    this.name = "PhoneAuthError";
    this.kind = kind;
  }
}

/** The kind of any failure: a typed one, a failed send, or (everything else) `generic`. Never throws. */
export function phoneAuthKindOf(error: unknown): PhoneAuthErrorKind {
  if (error instanceof PhoneAuthError) return error.kind;
  if (error instanceof Error && (error as Error & { sendFailed?: boolean }).sendFailed === true) return "send_failed";
  return "generic";
}
