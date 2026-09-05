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

  const tierResult = await getEffectiveManagerSkuTier(ownerId);
  if (!tierResult.ok) return { allowed: false, reason: "plan_unreadable" };
  if (tierResult.tier === "free") return { allowed: false, reason: "free_tier" };

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
      return "Texting and voice require a paid plan. Upgrade to Pro or Business, then add a payment method for usage billing.";
    case "no_payment_method":
      return "Add a payment method in Settings before sending texts or taking calls on your work number.";
    case "billing_paused":
      return "Communication is paused until your payment method is updated.";
    case "plan_unreadable":
      return "We could not verify your plan. Try again in a moment or contact support.";
  }
}
