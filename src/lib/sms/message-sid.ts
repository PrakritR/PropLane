/** Twilio Message resources use either the SMS or MMS prefix. */
export function isTwilioMessageSid(value: unknown): value is string {
  return typeof value === "string" && /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(value);
}
