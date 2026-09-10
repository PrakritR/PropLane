import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTwilioRestClient } from "@/lib/twilio-client.server";
import {
  isVoiceRecordingEnabled,
  resolveVoiceTurnWebhookUrl,
  twimlGatherSpeech,
  twimlHangup,
  twimlSay,
} from "@/lib/twilio-voice.server";
import {
  finishCommsCredit,
  loadCommsWallet,
  reserveCommsCredit,
} from "./wallet.server";

export const VOICE_CREDIT_UNAVAILABLE =
  "This number cannot take calls right now. Please try again later.";

export async function reserveBoundedVoiceCall(
  db: SupabaseClient,
  owner: string,
  callSid: string,
): Promise<boolean> {
  const wallet = await loadCommsWallet(db, owner);
  if (wallet.paused) return false;
  const recording = isVoiceRecordingEnabled();
  const minutes = Math.min(
    5,
    Math.floor((wallet.remainingCents - 20) / (recording ? 5 : 4)),
  );

  const key = `voice_minute:${callSid}`;
  // Replayed inbound callbacks reuse their original duration instead of reserving again.
  const { data: existing, error } = await db
    .from("manager_comms_usage_events")
    .select("quantity,credit_state")
    .eq("manager_user_id", owner)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error) throw new Error("Call credit unavailable.");
  if (existing) {
    if (existing.credit_state !== "reserved") return false;
    if (recording) {
      const { data: hold, error: holdError } = await db
        .from("manager_comms_usage_events")
        .select("credit_state")
        .eq("manager_user_id", owner)
        .eq("idempotency_key", `voice_recording_minute:${callSid}`)
        .maybeSingle();
      if (holdError || hold?.credit_state !== "reserved") return false;
    }
    const client = createTwilioRestClient();
    if (!client) return false;
    try {
      await client
        .calls(callSid)
        .update({ timeLimit: Number(existing.quantity) * 60 });
    } catch {
      return false;
    }
    // Never release a shared hold while a retry could be answering the call.
    return true;
  }
  if (minutes < 1) return false;
  const voice = await reserveCommsCredit(db, {
    managerUserId: owner,
    meter: "voice_minute",
    quantity: minutes,
    idempotencyKey: key,
  });
  if (!voice.allowed || voice.duplicate) return false;
  const recordingKey = `voice_recording_minute:${callSid}`;
  if (recording) {
    const hold = await reserveCommsCredit(db, {
      managerUserId: owner,
      meter: "voice_recording_minute",
      quantity: minutes,
      idempotencyKey: recordingKey,
    });
    if (!hold.allowed) {
      await finishCommsCredit(db, owner, key, true);
      return false;
    }
  }
  const client = createTwilioRestClient();
  try {
    if (!client) throw new Error("Call duration control unavailable.");
    await client.calls(callSid).update({ timeLimit: minutes * 60 });
  } catch {
    // The terminal status callback settles the hold; another request may have applied the bound.
    return false;
  }
  return true;
}

/** Reserve recognition before emitting a Gather. A signed turn id makes retries stable. */
export async function fundedVoiceGather(
  db: SupabaseClient,
  args: {
    owner: string;
    callSid: string;
    turnId: string;
    phase: "consent" | "agent";
    prompt: string;
  },
): Promise<string> {
  const key = `voice_gather:${args.callSid}:${args.turnId}`;
  const credit = await reserveCommsCredit(db, {
    managerUserId: args.owner,
    meter: "voice_speech_gather",
    idempotencyKey: key,
  });
  if (!credit.allowed)
    return twimlSay(VOICE_CREDIT_UNAVAILABLE) + twimlHangup();
  await finishCommsCredit(db, args.owner, key);
  const nextTurn = createHash("sha256")
    .update(`${args.callSid}:${args.turnId}`)
    .digest("hex")
    .slice(0, 32);
  return twimlGatherSpeech({
    actionUrl: resolveVoiceTurnWebhookUrl(args.phase, nextTurn),
    prompt: args.prompt,
  });
}

export async function settleVoiceCredit(
  db: SupabaseClient,
  owner: string,
  callSid: string,
  seconds: number,
  recordingSeconds?: number,
) {
  for (const [meter, duration] of [
    ["voice_minute", seconds],
    ["voice_recording_minute", recordingSeconds],
  ] as const) {
    if (duration === undefined) continue;
    const { error } = await db.rpc("settle_comms_credit_quantity", {
      p_owner: owner,
      p_key: `${meter}:${callSid}`,
      p_quantity: Math.ceil(Math.max(0, duration) / 60),
    });
    if (error) throw new Error("Call credit settlement unavailable.");
  }
  const { maybeNotifyCommsBudgetThreshold } =
    await import("./notifications.server");
  await maybeNotifyCommsBudgetThreshold(db, owner).catch(() => undefined);
}

/** At terminal status, no recording object means there will be no recording
 * callback. Provider lookup failures keep the hold and make the webhook retry. */
export async function reconcileUnstartedRecording(
  db: SupabaseClient,
  owner: string,
  callSid: string,
) {
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .select("credit_state")
    .eq("manager_user_id", owner)
    .eq("idempotency_key", `voice_recording_minute:${callSid}`)
    .maybeSingle();
  if (error) throw new Error("Recording credit unavailable.");
  if (data?.credit_state !== "reserved") return;
  const client = createTwilioRestClient();
  if (!client) throw new Error("Recording status unavailable.");
  const recordings = await client.calls(callSid).recordings.list({ limit: 1 });
  if (recordings.length === 0)
    await settleVoiceCredit(db, owner, callSid, 0, 0);
}
