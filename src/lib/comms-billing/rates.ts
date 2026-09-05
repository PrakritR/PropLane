/** Retail USD rates for manager communication pay-as-you-go billing. */

export type CommsBillingMeter =
  | "sms_outbound_segment"
  | "sms_inbound_segment"
  | "voice_minute"
  | "voice_speech_gather"
  | "voice_recording_minute"
  | "ai_agent_turn"
  | "work_number_monthly";

export const COMMS_BILLING_RATES_CENTS: Record<CommsBillingMeter, number> = {
  sms_outbound_segment: 3,
  sms_inbound_segment: 2,
  voice_minute: 4,
  voice_speech_gather: 5,
  voice_recording_minute: 1,
  ai_agent_turn: 15,
  work_number_monthly: 300,
};

export const COMMS_BILLING_METER_LABELS: Record<CommsBillingMeter, string> = {
  sms_outbound_segment: "Outbound SMS (per segment)",
  sms_inbound_segment: "Inbound SMS (per segment)",
  voice_minute: "Voice (per minute)",
  voice_speech_gather: "Voice speech recognition",
  voice_recording_minute: "Call recording (per minute)",
  ai_agent_turn: "AI assistant turn",
  work_number_monthly: "Work number (monthly)",
};

export function isCommsPaygBillingEnabled(): boolean {
  return process.env.COMMS_PAYG_BILLING_ENABLED?.trim() === "1";
}

export function unitPriceCentsForMeter(meter: CommsBillingMeter): number {
  return COMMS_BILLING_RATES_CENTS[meter];
}

export function formatUsdFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
