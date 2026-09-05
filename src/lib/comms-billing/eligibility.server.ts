import type { SupabaseClient } from "@supabase/supabase-js";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { areCommsLimitsEnforced } from "@/lib/comms-billing/rates";
import { refreshManagerCommsPaymentMethod } from "@/lib/comms-billing/payment-method.server";
import {
  commsAllowanceBlockedMessage,
  evaluateCommsAllowance,
  normalizeCommsPlanTier,
} from "@/lib/comms-billing/allowances";
import { monthToDateUsageCents } from "@/lib/comms-billing/summary.server";

export type CommsBillingBlockReason =
  | "free_tier"
  | "no_payment_method"
  | "allowance_exhausted"
  | "billing_paused"
  | "plan_unreadable";

export type CommsBillingGateResult =
  | { allowed: true; billingOwnerId: string }
  | { allowed: false; reason: CommsBillingBlockReason };

export async function evaluateManagerCommsBillingGate(
  db: SupabaseClient,
  managerUserId: string,
): Promise<CommsBillingGateResult> {
  // Keyed on LIMITS, not on billing. Gating this on the pay-as-you-go billing
  // switch meant that with billing off — its default — this returned "allowed"
  // for everyone and every plan had unlimited texting, calling and AI. Limits
  // hold whether or not usage is being charged; charging is a separate switch.
  if (!areCommsLimitsEnforced()) {
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

  // Every plan includes a real allowance, so a manager can set up a work number
  // and use it with NO card at all. A card is only required once that allowance
  // is spent — which is the point at which usage starts costing money.
  const tier = normalizeCommsPlanTier(tierResult.tier);
  const usedCents = await monthToDateUsageCents(db, ownerId);
  const allowance = evaluateCommsAllowance({
    tier,
    usedCents,
    hasPaymentMethod: payment.hasPaymentMethod,
  });
  if (allowance.blocked) return { allowed: false, reason: "allowance_exhausted" };

  return { allowed: true, billingOwnerId: ownerId };
}

export function commsBillingBlockMessage(reason: CommsBillingBlockReason): string {
  switch (reason) {
    case "free_tier":
      // Retained for stored rows written before plan gating was dropped.
      return "Add a payment method in Settings to use texting and voice on your work number.";
    case "allowance_exhausted":
      // The one refusal a manager can act on immediately, so it says the
      // number and the fix rather than "not allowed".
      return commsAllowanceBlockedMessage("free");
    case "no_payment_method":
      return "Add a payment method in Settings before sending texts or taking calls on your work number. Usage is billed as you go on any plan, including Free.";
    case "billing_paused":
      return "Communication is paused until your payment method is updated.";
    case "plan_unreadable":
      return "We could not verify your plan. Try again in a moment or contact support.";
  }
}
