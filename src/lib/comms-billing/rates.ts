/** Retail USD rates for manager communication pay-as-you-go billing. */

export type CommsBillingMeter =
  | "sms_outbound_segment"
  | "sms_inbound_segment"
  | "voice_minute"
  | "voice_speech_gather"
  | "voice_recording_minute"
  | "ai_agent_turn"
  | "work_number_monthly"
  | "work_number_setup";

export const COMMS_BILLING_RATES_CENTS: Record<CommsBillingMeter, number> = {
  sms_outbound_segment: 3,
  sms_inbound_segment: 2,
  voice_minute: 4,
  voice_speech_gather: 5,
  voice_recording_minute: 1,
  ai_agent_turn: 15,
  // The work number itself is FREE on every plan, including Free — a manager
  // cannot evaluate PropLane without one, and charging setup put a paywall in
  // front of the first thing a new account does. The meters are kept at zero
  // rather than deleted so the usage ledger still records that a number exists
  // and a price can be reinstated without a schema change. What IS limited is
  // what the number DOES: see `allowances.ts`.
  work_number_monthly: 0,
  work_number_setup: 0,
};

export const COMMS_BILLING_METER_LABELS: Record<CommsBillingMeter, string> = {
  sms_outbound_segment: "Outbound SMS (per segment)",
  sms_inbound_segment: "Inbound SMS (per segment)",
  voice_minute: "Voice (per minute)",
  voice_speech_gather: "Voice speech recognition",
  voice_recording_minute: "Call recording (per minute)",
  ai_agent_turn: "AI assistant turn",
  work_number_monthly: "Work number (monthly)",
  work_number_setup: "Work number setup (one-time)",
};

/**
 * Whether usage is actually CHARGED to a card.
 *
 * Opt-in, and deliberately separate from {@link areCommsLimitsEnforced}: money
 * leaving a manager's card is the one behaviour that must never switch on by
 * default because an environment variable went missing.
 */
export function isCommsPaygBillingEnabled(): boolean {
  return process.env.COMMS_PAYG_BILLING_ENABLED?.trim() === "1";
}

/**
 * Whether per-plan communication allowances are metered and enforced.
 *
 * ON unless explicitly disabled, because this flag fails OPEN: when it is off
 * nothing meters and nothing stops, so every plan — Free included — gets
 * unlimited texting, calling and AI. That is the opposite of the intent, and it
 * is invisible, since an unlimited account looks exactly like a working one.
 *
 * Enforcing a limit is not the same as charging for it. Limits can be on while
 * {@link isCommsPaygBillingEnabled} is off: a manager past their allowance is
 * asked to add a card, and nothing is billed until PAYG is switched on too.
 */
export function areCommsLimitsEnforced(): boolean {
  return process.env.COMMS_LIMITS_ENFORCED?.trim() !== "0";
}

export function unitPriceCentsForMeter(meter: CommsBillingMeter): number {
  return COMMS_BILLING_RATES_CENTS[meter];
}

export function formatUsdFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
