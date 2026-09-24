import type { SupabaseClient } from "@supabase/supabase-js";
import { finishCommsCredit } from "./wallet.server";

export const INTERRUPTED_COMMS_REPLY =
  "This reply was interrupted. Please check the portal before trying again; an earlier action may already have completed.";
const STALE_TURN_MS = 10 * 60 * 1000;

/** A turn's credit key family is `base`, `base:r1`, `base:r2`, ... An attempt
 * that produced no outcome before any tool ran (a failed model call) gets a
 * fresh key instead of replaying nothing forever: a released hold, or a legacy
 * settled `null` result cached before failures were released. Otherwise the
 * latest key is returned and the normal duplicate replay applies. */
export async function commsTurnKey(
  db: SupabaseClient,
  owner: string,
  base: string,
): Promise<string> {
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .select("idempotency_key,credit_state,metadata")
    .eq("manager_user_id", owner)
    .like("idempotency_key", `${base}%`)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Communication credit could not be read. Retry delivery.");
  const family = (data ?? []).filter(
    // LIKE treats `_` and `%` as wildcards, so re-check the exact prefix.
    (row) => String(row.idempotency_key).startsWith(base) &&
      (row.idempotency_key === base || /^:r\d+$/.test(String(row.idempotency_key).slice(base.length))),
  );
  const latest = family[0];
  if (!latest) return base;
  const meta = (latest.metadata ?? {}) as Record<string, unknown>;
  const emptyOutcome = latest.credit_state === "settled" && meta.turnCompleted === true &&
    meta.turnResult === null && meta.turnToolsRan !== true && meta.turnInterrupted !== true;
  return latest.credit_state === "released" || emptyOutcome
    ? `${base}:r${family.length}`
    : String(latest.idempotency_key);
}

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
  toolsRan = false,
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
    .update({ metadata: { ...reserved, turnCompleted: true, turnResult: result, ...(toolsRan ? { turnToolsRan: true } : {}) } })
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
