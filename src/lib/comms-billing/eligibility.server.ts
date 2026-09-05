import type { SupabaseClient } from "@supabase/supabase-js";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { refreshManagerCommsPaymentMethod } from "@/lib/comms-billing/payment-method.server";

export type CommsBillingBlockReason =
  | "free_tier"
  | "no_payment_method"
  | "billing_paused"
  | "plan_unreadable";

export type CommsBillingGateResult =
  | { allowed: true; billingOwnerId: string }
  | { allowed: false; reason: CommsBillingBlockReason };

export async function evaluateManagerCommsBillingGate(
  db: SupabaseClient,
  managerUserId: string,
): Promise<CommsBillingGateResult> {
  if (!isCommsPaygBillingEnabled()) {
    return { allowed: true, billingOwnerId: managerUserId.trim() };
  }

  const ownerId = managerUserId.trim();
  if (!ownerId) return { allowed: false, reason: "plan_unreadable" };

  // Plan no longer gates communication. Under pay-as-you-go the cost is billed
  // rather than bundled, so a FREE manager with a card on file may text and take
  // calls exactly like a paid one — the card is the requirement, not the tier.
  // The plan is still read, because an unreadable plan means we cannot identify
  // the billing account at all, and that must fail closed rather than bill the
  // wrong person.
  const tierResult = await getEffectiveManagerSkuTier(ownerId);
  if (!tierResult.ok) return { allowed: false, reason: "plan_unreadable" };

  const { data: account } = await db
    .from("manager_comms_billing_accounts")
    .select("billing_paused_at")
    .eq("manager_user_id", ownerId)
    .maybeSingle();
  if (account?.billing_paused_at) return { allowed: false, reason: "billing_paused" };

  const payment = await refreshManagerCommsPaymentMethod(db, ownerId);
  if (!payment.hasPaymentMethod) return { allowed: false, reason: "no_payment_method" };

  return { allowed: true, billingOwnerId: ownerId };
}

export function commsBillingBlockMessage(reason: CommsBillingBlockReason): string {
  switch (reason) {
    case "free_tier":
      // Retained for stored rows written before plan gating was dropped.
      return "Add a payment method in Settings to use texting and voice on your work number.";
    case "no_payment_method":
      return "Add a payment method in Settings before sending texts or taking calls on your work number. Usage is billed as you go on any plan, including Free.";
    case "billing_paused":
      return "Communication is paused until your payment method is updated.";
    case "plan_unreadable":
      return "We could not verify your plan. Try again in a moment or contact support.";
  }
}
