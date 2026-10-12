import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCommsWallet } from "./wallet.server";

export type CommsBillingBlockReason =
  | "free_tier"
  | "no_payment_method"
  | "allowance_exhausted"
  | "billing_paused"
  | "plan_unreadable"
  /** A live signup trial: no Communication until the account pays. Refused before any credit math. */
  | "trial";

export type CommsBillingGateResult =
  | { allowed: true; billingOwnerId: string }
  | { allowed: false; reason: CommsBillingBlockReason };

/**
 * `workspaceId` is the workspace the message leaves from — its wallet pays.
 * Omitted, the owner's default workspace answers.
 */
export async function evaluateManagerCommsBillingGate(
  db: SupabaseClient, managerUserId: string, requiredCents = 1, workspaceId?: string | null,
): Promise<CommsBillingGateResult> {
  if (!managerUserId.trim()) return { allowed: false, reason: "plan_unreadable" };
  try {
    const wallet = await loadCommsWallet(db, managerUserId, workspaceId ?? undefined);
    // Checked first: a trial has no Communication even if it somehow holds purchased credit.
    if (wallet.liveSignupTrial === true) return { allowed: false, reason: "trial" };
    if (wallet.paused) return { allowed: false, reason: "billing_paused" };
    if (wallet.remainingCents < requiredCents) return { allowed: false, reason: "allowance_exhausted" };
    return { allowed: true, billingOwnerId: managerUserId };
  } catch {
    return { allowed: false, reason: "plan_unreadable" };
  }
}

/**
 * The refusal, worded for the channel the manager was actually asking for.
 *
 * Defaults to the work number so every existing caller keeps its exact copy.
 * Only the two channel-specific refusals differ; the rest are about the billing
 * account itself and read the same either way.
 */
export function commsBillingBlockMessage(
  reason: CommsBillingBlockReason,
  channel: "work_number" | "work_email" = "work_number",
): string {
  const forEmail = channel === "work_email";
  switch (reason) {
    case "free_tier":
      // Retained for stored rows written before plan gating was dropped.
      return forEmail
        ? "Add a payment method in Settings to use your PropLane work email."
        : "Add a payment method in Settings to use texting and voice on your work number.";
    case "allowance_exhausted":
      // The one refusal a manager can act on immediately, so it says the
      // number and the fix rather than "not allowed".
      return "You’ve used your available communication credit. Buy more usage in Settings → Billing & plan to keep sending.";
    case "no_payment_method":
      return forEmail
        ? "Add a payment method in Settings before setting up your work email. Communication usage is billed as you go on any plan, including Free."
        : "Add a payment method in Settings before sending texts or taking calls on your work number. Usage is billed as you go on any plan, including Free.";
    case "billing_paused":
      return "Communication is paused for billing review. Contact PropLane.";
    case "plan_unreadable":
      return "We could not verify your plan. Try again in a moment or contact support.";
    case "trial":
      return "Communication is available on a paid plan.";
  }
}
