export type ManualSmsAttempt = {
  signature: string;
  idempotencyKeys: string[];
};

export const MANUAL_SMS_UNKNOWN_MESSAGE =
  "The provider outcome could not be confirmed. Do not resend this message. PropLane has kept it for operator review; check the conversation later.";

export function isManualSmsOutcomeUnknown(response: {
  code?: string;
  status?: string;
}): boolean {
  return (
    response.code === "delivery_outcome_unknown" ||
    response.status === "unknown"
  );
}

/** True only when Twilio accepted the message (not queued/deferred). */
export function isManualSmsSubmitted(response: { status?: string }): boolean {
  return response.status === "submitted";
}

export const MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE =
  "We could not confirm whether the provider received this message. Do not resend it. PropLane has kept the attempt for operator review; check the conversation later.";

function newAttemptId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replace(/-/g, "");
  }
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
}

/**
 * Keep one key per recipient stable while the manual-send draft is unchanged.
 * A changed message or recipient list is a new user attempt and gets new keys.
 */
export function resolveManualSmsAttempt(
  current: ManualSmsAttempt | null,
  signature: string,
  recipientCount: number,
  createId: () => string = newAttemptId,
): ManualSmsAttempt {
  if (
    current?.signature === signature &&
    current.idempotencyKeys.length === recipientCount
  ) {
    return current;
  }
  const attemptId = createId()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80);
  return {
    signature,
    idempotencyKeys: Array.from(
      { length: recipientCount },
      (_, index) => `manual_${attemptId}_${index}`,
    ),
  };
}
