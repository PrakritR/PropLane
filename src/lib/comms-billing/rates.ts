/** Retail USD rates for manager communication credit (prepaid; see docs/agents/comms-billing.md). */

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
 * Whether manual credit-pack checkout is offered (`POST /api/manager/comms-billing/checkout`).
 *
 * Opt-in: money leaving a manager's card is the one behaviour that must never
 * switch on by default because an environment variable went missing. It does
 * NOT gate credit enforcement — reservations and blocks apply regardless.
 */
export function isCommsPaygBillingEnabled(): boolean {
  return process.env.COMMS_PAYG_BILLING_ENABLED?.trim() === "1";
}

/**
 * @deprecated No caller consults this. Prepaid credit is always enforced
 * (`wallet.server.ts` reserves before every outgoing action); `COMMS_LIMITS_ENFORCED=0`
 * cannot disable it. Kept only so an env still setting the flag does not break.
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

/** Whole-cent retail rate as marketing copy: "3¢", or "$1.50" once it passes a dollar. */
export function formatCentsRate(cents: number): string {
  return cents < 100 ? `${cents}¢` : formatUsdFromCents(cents);
}
