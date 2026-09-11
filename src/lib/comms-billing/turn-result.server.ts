import type { SupabaseClient } from "@supabase/supabase-js";
import { finishCommsCredit } from "./wallet.server";

export const INTERRUPTED_COMMS_REPLY =
  "This reply was interrupted. Please check the portal before trying again; an earlier action may already have completed.";
const STALE_TURN_MS = 10 * 60 * 1000;

/** Replays never repeat model tools. A stale interrupted turn becomes an explicit
 * terminal reply; any existing pending action remains reviewable in the portal. */
export async function readCommsTurnResult<T>(
  db: SupabaseClient,
  owner: string,
  key: string,
  interruptedResult?: T,
): Promise<T | null> {
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .select("metadata,created_at")
    .eq("manager_user_id", owner)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error || !data)
    throw new Error("Communication reply could not be read. Retry delivery.");
  if (data.metadata?.turnCompleted !== true) {
    if (
      interruptedResult === undefined ||
      Date.now() - Date.parse(data.created_at) < STALE_TURN_MS
    ) {
      throw new Error(
        "Communication reply is still processing. Retry delivery.",
      );
    }
    const { data: claimed, error: claimError } = await db
      .from("manager_comms_usage_events")
      .update({
        metadata: {
          ...data.metadata,
          turnCompleted: true,
          turnInterrupted: true,
          turnResult: interruptedResult,
        },
      })
      .eq("manager_user_id", owner)
      .eq("idempotency_key", key)
      .eq("metadata", JSON.stringify(data.metadata))
      .eq("credit_state", "reserved")
      .select("id")
      .maybeSingle();
    if (claimError || !claimed)
      throw new Error(
        "Communication reply recovery is in progress. Retry delivery.",
      );
    await finishCommsCredit(db, owner, key);
    return interruptedResult;
  }
  await finishCommsCredit(db, owner, key);
  return data.metadata.turnResult as T | null;
}

export async function completeCommsTurn<T>(
  db: SupabaseClient,
  owner: string,
  key: string,
  result: T | null,
): Promise<T | null> {
  const { data: reservation, error: readError } = await db
    .from("manager_comms_usage_events")
    .select("metadata")
    .eq("manager_user_id", owner)
    .eq("idempotency_key", key)
    .eq("credit_state", "reserved")
    .maybeSingle();
  if (readError || !reservation)
    throw new Error("Communication reply could not be saved. Retry delivery.");
  const reserved =
    reservation.metadata && typeof reservation.metadata === "object"
      ? (reservation.metadata as Record<string, unknown>)
      : {};
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .update({ metadata: { ...reserved, turnCompleted: true, turnResult: result } })
    .eq("manager_user_id", owner)
    .eq("idempotency_key", key)
    .eq("credit_state", "reserved")
    .select("id")
    .maybeSingle();
  if (error || !data)
    throw new Error("Communication reply could not be saved. Retry delivery.");
  await finishCommsCredit(db, owner, key);
  return result;
}
