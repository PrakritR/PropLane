import type { SupabaseClient } from "@supabase/supabase-js";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";

export async function recordCommsAgentTurnUsage(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    idempotencyKey: string;
    channel: "sms" | "voice";
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!isCommsPaygBillingEnabled()) return;
  await recordManagerCommsUsage(db, {
    managerUserId: args.managerUserId,
    meter: "ai_agent_turn",
    idempotencyKey: args.idempotencyKey,
    metadata: { channel: args.channel, ...args.metadata },
  });
}

export async function recordVoiceSpeechGatherUsage(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    callSid: string;
    turnKey: string;
  },
): Promise<void> {
  if (!isCommsPaygBillingEnabled()) return;
  await recordManagerCommsUsage(db, {
    managerUserId: args.managerUserId,
    meter: "voice_speech_gather",
    idempotencyKey: `voice_gather:${args.callSid}:${args.turnKey}`,
    metadata: { callSid: args.callSid },
  });
}
