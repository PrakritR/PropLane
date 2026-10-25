/**
 * Errors the Settings "Verify phone" flow (`purpose: "verify_own_phone"`) may say out loud. Every other phone-auth
 * door stays on the one deliberately generic message (`PHONE_AUTH_ERROR`); this flow is a signed-in person verifying
 * the number on their own profile, so it can name the three outcomes they can act on.
 */
export const PHONE_TAKEN_MESSAGE = "This number is verified on another account.";
export const PHONE_WRONG_CODE_MESSAGE = "That code didn't match. Try again.";
export const PHONE_EXPIRED_CODE_MESSAGE = "That code expired. Send a new one.";

export type PhoneOwnFlowReason = "taken" | "wrong" | "expired";

const MESSAGES: Record<PhoneOwnFlowReason, string> = {
  taken: PHONE_TAKEN_MESSAGE,
  wrong: PHONE_WRONG_CODE_MESSAGE,
  expired: PHONE_EXPIRED_CODE_MESSAGE,
};

export class PhoneOwnFlowError extends Error {
  readonly reason: PhoneOwnFlowReason;
  constructor(reason: PhoneOwnFlowReason) {
    super(MESSAGES[reason]);
    this.name = "PhoneOwnFlowError";
    this.reason = reason;
  }
}
