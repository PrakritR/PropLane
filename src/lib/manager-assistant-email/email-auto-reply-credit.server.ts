import "server-only";

/**
 * Communication credit for the work-email auto-reply (screen J, D10).
 *
 * An email reply to a prospect or resident is free to SEND (work email is
 * unmetered) but the assistant turn that writes it is a paid `ai_agent_turn`,
 * exactly like the same assistant answering by text. The text path reserves
 * before the model runs (`runLeasingSmsAgentTurn`); the email path used to run
 * the model with no reservation at all, so an empty wallet still paid for
 * replies. This is the same gate:
 *
 * - RESERVE before any model work, keyed on the inbound email so a redelivery
 *   can never pay twice (`ai_turn:email:<inboundEmailId>`; a released hold gets a
 *   fresh `:rN` key from `commsTurnKey`, like the text agents).
 * - FAIL CLOSED: a denied reservation, an unknown workspace under the pool, a
 *   duplicate (the first delivery already ran the turn) or an unreadable ledger
 *   all mean no model run and no reply. The inbound is still mirrored.
 * - SETTLE when the turn produced a reply, RELEASE when it produced nothing, so
 *   a model outage never bills the manager.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { commsTurnKey } from "@/lib/comms-billing/turn-result.server";
import { finishCommsCredit, reserveCommsCredit } from "@/lib/comms-billing/wallet.server";

/**
 * A reservation older than this whose turn never completed belongs to a delivery that died between
 * reserving and replying. It is handed back so a redelivery can answer once, instead of the manager
 * paying for a reply that was never written and the sender hearing nothing at all.
 */
const STALE_RESERVATION_MS = 10 * 60 * 1000;

async function releaseStaleReservation(db: SupabaseClient, managerUserId: string, key: string): Promise<boolean> {
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .select("created_at,credit_state,metadata")
    .eq("manager_user_id", managerUserId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error || !data) return false;
  if (data.credit_state !== "reserved") return false;
  if ((data.metadata as Record<string, unknown> | null)?.turnCompleted === true) return false;
  const startedAt = Date.parse(String(data.created_at ?? ""));
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < STALE_RESERVATION_MS) return false;
  await finishCommsCredit(db, managerUserId, key, true);
  return true;
}

export type EmailAutoReplyCredit =
  | { allowed: true; key: string }
  | { allowed: false; reason: string };

export async function reserveEmailAutoReplyCredit(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    workspaceId?: string | null;
    inboundEmailId: string;
    role: "resident" | "prospect";
  },
): Promise<EmailAutoReplyCredit> {
  const emailId = args.inboundEmailId.trim();
  if (!args.managerUserId.trim() || !emailId) return { allowed: false, reason: "missing_identity" };
  const base = `ai_turn:email:${emailId}`;
  try {
    const reserve = async (key: string) =>
      reserveCommsCredit(db, {
        managerUserId: args.managerUserId,
        workspaceId: args.workspaceId ?? undefined,
        meter: "ai_agent_turn",
        idempotencyKey: key,
        metadata: { channel: "email", role: args.role, inboundEmailId: emailId },
      });
    let key = await commsTurnKey(db, args.managerUserId, base);
    let credit = await reserve(key);
    // A duplicate means an earlier delivery already ran (or is running) this exact turn; running the
    // model again would double-reply. A reservation left behind by a delivery that died is handed
    // back first, which gives `commsTurnKey` a fresh key for this one attempt.
    if (credit.allowed && credit.duplicate && (await releaseStaleReservation(db, args.managerUserId, key))) {
      key = await commsTurnKey(db, args.managerUserId, base);
      credit = await reserve(key);
    }
    if (!credit.allowed) return { allowed: false, reason: credit.reason };
    if (credit.duplicate) return { allowed: false, reason: "duplicate_turn" };
    return { allowed: true, key };
  } catch (error) {
    console.error("email auto-reply credit unavailable", error instanceof Error ? error.message : "unknown");
    return { allowed: false, reason: "credit_unavailable" };
  }
}

/** Keep the debit when a reply was produced; hand it back when nothing was. */
export async function finishEmailAutoReplyCredit(
  db: SupabaseClient,
  args: { managerUserId: string; key: string; replyProduced: boolean },
): Promise<void> {
  try {
    await finishCommsCredit(db, args.managerUserId, args.key, !args.replyProduced);
  } catch (error) {
    console.error("email auto-reply credit reconcile failed", error instanceof Error ? error.message : "unknown");
  }
}
