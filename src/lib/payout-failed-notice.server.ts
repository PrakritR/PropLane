import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";

const FAILURE_REASON_MAX = 200;

/**
 * Stripe's own reason for a failed payout, trimmed. Never a bank number: Stripe's `failure_message` is customer-safe
 * text, and the destination is never read or echoed here.
 */
export function payoutFailureReason(payout: Pick<Stripe.Payout, "failure_message" | "failure_code">): string {
  const message = String(payout.failure_message ?? "").replace(/\s+/g, " ").trim();
  if (message) return message.slice(0, FAILURE_REASON_MAX);
  const code = String(payout.failure_code ?? "").replace(/_/g, " ").trim();
  return code ? code.slice(0, FAILURE_REASON_MAX) : "Your bank did not accept the deposit.";
}

/**
 * `payout.failed` on a manager's or Property owner's Connect account: tell the account holder once, in the inbox and by
 * email, with Stripe's reason. The caller skips vendor accounts (vendor banking tells them). Idempotent on the payout id, so a Stripe
 * redelivery tells them once. Never throws: the payout row is already written.
 */
export async function notifyOwnerOfFailedPayout(
  db: SupabaseClient,
  ownerUserId: string,
  payout: Stripe.Payout,
  priorStatus: string | null,
): Promise<void> {
  try {
    if (payout.status !== "failed" || priorStatus === "failed") return;
    const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: (payout.currency || "usd").toUpperCase() }).format(payout.amount / 100);
    await notifyManagerFromAgent(db, {
      landlordId: ownerUserId,
      subject: "A payout to your bank failed",
      text: `Your ${amount} payout did not reach your bank. Reason: ${payoutFailureReason(payout)} Check your bank details in Balance & payouts, then withdraw again.`,
      url: "/portal/profile?tab=payments",
      idempotencyKey: `payout-failed:${payout.id}`,
      notify: { push: true, sms: false },
    });
  } catch (e) {
    console.error("[stripe webhook] payout failed notice", e instanceof Error ? e.message : "error");
  }
}
