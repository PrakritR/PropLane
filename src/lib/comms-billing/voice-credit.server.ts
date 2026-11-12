import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTwilioRestClient } from "@/lib/twilio-client.server";
import {
  isVoiceRecordingEnabled,
  resolveVoiceStatusWebhookUrl,
  resolveVoiceTurnWebhookUrl,
  twimlGatherSpeech,
  twimlHangup,
  twimlSay,
} from "@/lib/twilio-voice.server";
import { unitPriceCentsForMeter } from "./rates";
import {
  finishCommsCredit,
  loadCommsWallet,
  reserveCommsCredit,
  settleCommsCreditQuantity,
} from "./wallet.server";

export const VOICE_CREDIT_UNAVAILABLE =
  "This number cannot take calls right now. Please try again later.";

/** Every inbound call is bounded, and never longer than this. */
const MAX_BOUNDED_CALL_MINUTES = 5;

/** Who pays for a call. `allowUnfunded` is only ever true for PropLane itself paying on a PropLane-run line. */
export type VoicePayer = { ownerId: string; workspaceId: string | null; allowUnfunded: boolean };
export type VoiceBillingTarget = { ownerId: string; workspaceId: string | null };
/**
 * The two wallets a call may draw on. `primary` is the workspace the call belongs to; `platform` is PropLane's own
 * (the service owner's), present only on a PropLane-run line (the 206, a PropLane-managed workspace) where an empty
 * workspace wallet must never turn a caller away (comms-billing.md: an unavoidable cost always finds a payer).
 */
export type VoiceBilling = { primary: VoiceBillingTarget; platform: VoiceBillingTarget | null };

export async function reserveBoundedVoiceCall(
  db: SupabaseClient,
  owner: string,
  callSid: string,
  workspaceId?: string | null,
  options: { allowUnfunded?: boolean } = {},
): Promise<boolean> {
  const allowUnfunded = options.allowUnfunded === true;
  // PropLane paying on its own line is a fixed five-minute bound: the wallet is not the limit, and a paused or empty
  // wallet (a client's, or the platform's own) never turns the caller away.
  const wallet = allowUnfunded
    ? { paused: false, remainingCents: Number.MAX_SAFE_INTEGER }
    : await loadCommsWallet(db, owner, workspaceId ?? undefined);
  if (wallet.paused) return false;
  const recording = isVoiceRecordingEnabled();
  // Priced from the rate table, never from copied constants: a rate change must
  // move the bound with it or a funded caller is turned away as unfunded.
  const perMinuteCents =
    unitPriceCentsForMeter("voice_minute") +
    (recording ? unitPriceCentsForMeter("voice_recording_minute") : 0);
  // Headroom for the first recognition + answer, which are reserved separately
  // once the call connects.
  const turnHeadroomCents =
    unitPriceCentsForMeter("voice_speech_gather") +
    unitPriceCentsForMeter("ai_agent_turn");
  const minutes =
    allowUnfunded || perMinuteCents <= 0
      ? MAX_BOUNDED_CALL_MINUTES
      : perMinuteCents > 0
      ? Math.min(
          MAX_BOUNDED_CALL_MINUTES,
          Math.floor((wallet.remainingCents - turnHeadroomCents) / perMinuteCents),
        )
      : MAX_BOUNDED_CALL_MINUTES;

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
      await client.calls(callSid).update(callBound(Number(existing.quantity)));
    } catch {
      return false;
    }
    // Never release a shared hold while a retry could be answering the call.
    return true;
  }
  if (minutes < 1) return false;
  const voice = await reserveCommsCredit(db, {
    managerUserId: owner,
    workspaceId,
    meter: "voice_minute",
    quantity: minutes,
    idempotencyKey: key,
  }, allowUnfunded);
  if (!voice.allowed || voice.duplicate) return false;
  const recordingKey = `voice_recording_minute:${callSid}`;
  if (recording) {
    const hold = await reserveCommsCredit(db, {
      managerUserId: owner,
      workspaceId,
      meter: "voice_recording_minute",
      quantity: minutes,
      idempotencyKey: recordingKey,
    }, allowUnfunded);
    if (!hold.allowed) {
      await finishCommsCredit(db, owner, key, true);
      return false;
    }
  }
  const client = createTwilioRestClient();
  try {
    if (!client) throw new Error("Call duration control unavailable.");
    await client.calls(callSid).update(callBound(minutes));
  } catch {
    // The terminal status callback settles the hold; another request may have applied the bound.
    return false;
  }
  return true;
}

/**
 * The bound on the live call. The terminal status callback is attached to the call here too: Twilio only posts one to a
 * URL set on the number or the call, and the number's own voice configuration is not ours to rely on, so without it the
 * minutes are never settled and the post-call text, summary and alert never go out.
 */
function callBound(minutes: number) {
  return { timeLimit: minutes * 60, statusCallback: resolveVoiceStatusWebhookUrl(), statusCallbackMethod: "POST" };
}

/**
 * Reserve a call's minutes from the wallet that owns it, and when that cannot fund the call, from PropLane's own wallet
 * (only on a PropLane-run line). Null = nobody can fund it: the caller is told the number cannot take calls.
 */
export async function reserveVoiceCallFunding(db: SupabaseClient, billing: VoiceBilling, callSid: string): Promise<VoicePayer | null> {
  const { primary, platform } = billing;
  const primaryIsPlatform = Boolean(platform && platform.ownerId === primary.ownerId);
  const own = await reserveBoundedVoiceCall(db, primary.ownerId, callSid, primary.workspaceId, { allowUnfunded: primaryIsPlatform }).catch(() => false);
  if (own) return { ...primary, allowUnfunded: primaryIsPlatform };
  if (!platform || primaryIsPlatform) return null;
  const covered = await reserveBoundedVoiceCall(db, platform.ownerId, callSid, platform.workspaceId, { allowUnfunded: true }).catch(() => false);
  return covered ? { ...platform, allowUnfunded: true } : null;
}

/** Whoever holds this call's minutes (the reservation key names them), or null when none was ever taken. */
export async function findVoiceCallPayer(db: SupabaseClient, billing: VoiceBilling, callSid: string): Promise<VoicePayer | null> {
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .select("manager_user_id")
    .eq("idempotency_key", `voice_minute:${callSid}`)
    .maybeSingle();
  if (error || !data) return null;
  const owner = String((data as { manager_user_id?: unknown }).manager_user_id ?? "");
  if (billing.platform && owner === billing.platform.ownerId) return { ...billing.platform, allowUnfunded: true };
  if (owner === billing.primary.ownerId) return { ...billing.primary, allowUnfunded: Boolean(billing.platform && billing.platform.ownerId === owner) };
  return null;
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
    workspaceId?: string | null;
    /** PropLane paying on its own line: an empty wallet never stops a gather. */
    allowUnfunded?: boolean;
    /** How many times in a row this turn has heard silence (0 = a fresh turn). Each re-ask is its own recognition. */
    attempt?: number;
  },
): Promise<string> {
  const attempt = Math.max(0, Math.floor(args.attempt ?? 0));
  const key = `voice_gather:${args.callSid}:${args.turnId}${attempt > 0 ? `:a${attempt}` : ""}`;
  const credit = await reserveCommsCredit(db, {
    managerUserId: args.owner,
    workspaceId: args.workspaceId,
    meter: "voice_speech_gather",
    idempotencyKey: key,
  }, args.allowUnfunded === true);
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
    noInputUrl: resolveVoiceTurnWebhookUrl(args.phase, nextTurn, attempt + 1),
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
    await settleCommsCreditQuantity(db, owner, `${meter}:${callSid}`, Math.ceil(Math.max(0, duration) / 60));
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
