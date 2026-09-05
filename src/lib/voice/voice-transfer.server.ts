import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/twilio";

/**
 * Handing a live call to the manager's real phone.
 *
 * The agent answers on the WORK number. When a caller asks for a person, the
 * call is bridged to the manager's own mobile — the one they verified in
 * Settings, never a number supplied by the caller or read off the request.
 */

/** Spoken ways a caller asks for a human, kept deliberately narrow. */
const HUMAN_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(real|actual|live)\s+(person|human|agent)\b/i,
  /\b(speak|talk|connect|transfer)\s+(me\s+)?(to|with)\s+((a|the|my)\s+)?(person|human|manager|owner|landlord|someone)\b/i,
  /\b(human|person)\s+please\b/i,
  /\bget me (a|the|my) (person|human|manager)\b/i,
  /\btransfer (me|this call)\b/i,
  /\bcan i speak to (a|the|my) (person|human|manager|owner)\b/i,
];

export function callerWantsHuman(speech: string): boolean {
  const text = speech.trim();
  if (!text) return false;
  return HUMAN_REQUEST_PATTERNS.some((re) => re.test(text));
}

export type VoiceTransferTarget =
  | { ok: true; toPhone: string; callerId: string }
  | { ok: false; reason: "caller_is_manager" | "no_verified_mobile" | "would_loop" };

/**
 * The manager's verified personal mobile, or a reason it cannot be used.
 *
 * Three refusals, each of which would otherwise be a live-call failure:
 *   - the caller IS the manager, so bridging would ring their own phone;
 *   - no verified mobile on the profile — an unverified number is not a number
 *     we may dial on their behalf;
 *   - the stored mobile is the work number itself, which would loop the call
 *     straight back into this webhook.
 */
export async function resolveManagerTransferTarget(
  db: SupabaseClient,
  args: { managerUserId: string; workNumber: string; callerIsManager: boolean },
): Promise<VoiceTransferTarget> {
  if (args.callerIsManager) return { ok: false, reason: "caller_is_manager" };

  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at")
    .eq("id", args.managerUserId)
    .maybeSingle();

  const raw = String((data as { phone?: unknown } | null)?.phone ?? "").trim();
  const verifiedAt = (data as { phone_verified_at?: unknown } | null)?.phone_verified_at ?? null;
  if (!raw || !verifiedAt) return { ok: false, reason: "no_verified_mobile" };

  const toPhone = normalizeE164(raw);
  const callerId = normalizeE164(args.workNumber);
  if (!toPhone || !callerId) return { ok: false, reason: "no_verified_mobile" };
  if (toPhone === callerId) return { ok: false, reason: "would_loop" };

  return { ok: true, toPhone, callerId };
}

export type VoiceTransferRefusal = Extract<VoiceTransferTarget, { ok: false }>["reason"];

/** What the caller hears when no transfer is possible. */
export function transferUnavailablePrompt(reason: VoiceTransferRefusal): string {
  switch (reason) {
    case "caller_is_manager":
      return "You are already the account owner on this line, so there is no one to transfer you to.";
    case "would_loop":
      return "I cannot transfer that call right now. Please leave your question and it will reach the manager.";
    default:
      return "There is no verified mobile number on file to transfer to yet. Tell me what you need and the manager will get it in their inbox.";
  }
}
