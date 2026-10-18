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

type Row = Record<string, unknown>;

export async function loadRecordedTurn<T>(db: SupabaseClient, messageSid: string, phoneKey: string, now: Date = new Date()): Promise<T | null> {
  const { data, error } = await db.from("sms_onboarding_replies").select("phone_key, turn, created_at").eq("message_sid", messageSid).maybeSingle();
  if (error || !data) return null;
  const row = data as Row;
  if (row.phone_key !== phoneKey) return null;
  const created = Date.parse(String(row.created_at ?? ""));
  if (Number.isFinite(created) && now.getTime() - created > TURN_REPLAY_TTL_MS) return null;
  return row.turn && typeof row.turn === "object" ? (row.turn as T) : null;
}

export async function recordTurn(db: SupabaseClient, messageSid: string, phoneKey: string, turn: unknown, now: Date = new Date()): Promise<void> {
  try {
    // First writer wins: a concurrent duplicate keeps the reply the first one produced.
    await db.from("sms_onboarding_replies").upsert({ message_sid: messageSid, phone_key: phoneKey, turn, created_at: now.toISOString() }, { onConflict: "message_sid", ignoreDuplicates: true });
    await db.from("sms_onboarding_replies").delete().lt("created_at", new Date(now.getTime() - TURN_REPLAY_TTL_MS).toISOString());
  } catch {
    // A failed record only loses the replay; the turn itself already happened.
  }
}
