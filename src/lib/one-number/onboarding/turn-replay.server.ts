import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A Twilio retry of an unknown sender's text must get the SAME reply and move nothing a second time.
 * The whole turn is recorded under the provider MessageSid (`sms_onboarding_replies`) and returned
 * unchanged on a retry. The row can carry a live setup link, so it is pruned after an hour (Twilio
 * retries within minutes). With the table missing (code before the migration) nothing is recorded and
 * the turn behaves as it did before.
 */
export const TURN_REPLAY_TTL_MS = 60 * 60 * 1000;
/** A claim whose owner never finished (a crashed worker) can be taken over after this long. */
export const TURN_CLAIM_STALE_MS = 90 * 1000;

const PENDING_TURN = { __pending: true } as const;
const isPending = (turn: unknown): boolean => Boolean(turn && typeof turn === "object" && (turn as Row).__pending === true);

type Row = Record<string, unknown>;

export type TurnClaim<T> =
  /** This worker owns the turn: run it, then `completeTurn`. */
  | { kind: "won" }
  /** The turn already finished: send this back unchanged. */
  | { kind: "replay"; turn: T }
  /** Another worker is running this very text right now: do nothing, a later retry gets the recorded turn. */
  | { kind: "inflight" }
  /** No claim table (code before the migration): run the turn as before, unrecorded. */
  | { kind: "unavailable" };

/**
 * Claim a MessageSid BEFORE running its turn (insert-on-conflict on the primary key), so a Twilio retry
 * that lands while a slow model call is still running can never start a second turn. The first writer
 * wins; everyone else gets the finished turn, or "in flight" while it is still being produced.
 */
export async function claimTurn<T>(db: SupabaseClient, messageSid: string, phoneKey: string, now: Date = new Date()): Promise<TurnClaim<T>> {
  const createdAt = now.toISOString();
  const { error } = await db.from("sms_onboarding_replies").insert({ message_sid: messageSid, phone_key: phoneKey, turn: PENDING_TURN, created_at: createdAt });
  if (!error) return { kind: "won" };
  if (error.code !== "23505") return { kind: "unavailable" };
  const { data } = await db.from("sms_onboarding_replies").select("phone_key, turn, created_at").eq("message_sid", messageSid).maybeSingle();
  if (!data) return { kind: "unavailable" };
  const row = data as Row;
  if (row.phone_key !== phoneKey) return { kind: "unavailable" };
  const created = Date.parse(String(row.created_at ?? ""));
  const ageMs = Number.isFinite(created) ? now.getTime() - created : 0;
  if (!isPending(row.turn)) {
    if (ageMs > TURN_REPLAY_TTL_MS) return { kind: "unavailable" };
    return row.turn && typeof row.turn === "object" ? { kind: "replay", turn: row.turn as T } : { kind: "unavailable" };
  }
  if (ageMs <= TURN_CLAIM_STALE_MS) return { kind: "inflight" };
  // The owner died without finishing: exactly one retry takes the claim over (compare and swap on created_at).
  const { data: taken } = await db
    .from("sms_onboarding_replies")
    .update({ created_at: createdAt })
    .eq("message_sid", messageSid)
    .eq("created_at", String(row.created_at))
    .select("message_sid");
  return Array.isArray(taken) && taken.length === 1 ? { kind: "won" } : { kind: "inflight" };
}

/** Store the finished turn under the claim, and prune what has outlived replay. */
export async function completeTurn(db: SupabaseClient, messageSid: string, turn: unknown, now: Date = new Date()): Promise<void> {
  try {
    await db.from("sms_onboarding_replies").update({ turn }).eq("message_sid", messageSid);
    await db.from("sms_onboarding_replies").delete().lt("created_at", new Date(now.getTime() - TURN_REPLAY_TTL_MS).toISOString());
  } catch {
    // A failed record only loses the replay; the turn itself already happened.
  }
}

/** The turn threw: free the claim so the provider's retry can run it. */
export async function releaseTurn(db: SupabaseClient, messageSid: string): Promise<void> {
  try {
    await db.from("sms_onboarding_replies").delete().eq("message_sid", messageSid);
  } catch {
    // The stale-claim takeover frees it eventually.
  }
}
