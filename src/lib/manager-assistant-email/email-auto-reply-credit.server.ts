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
  try {
    const key = await commsTurnKey(db, args.managerUserId, `ai_turn:email:${emailId}`);
    const credit = await reserveCommsCredit(db, {
      managerUserId: args.managerUserId,
      workspaceId: args.workspaceId ?? undefined,
      meter: "ai_agent_turn",
      idempotencyKey: key,
      metadata: { channel: "email", role: args.role, inboundEmailId: emailId },
    });
    if (!credit.allowed) return { allowed: false, reason: credit.reason };
    // A duplicate means an earlier delivery already ran (or is running) this
    // exact turn; running the model again would double-reply.
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
