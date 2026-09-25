/**
 * Pure decisions for the per-workspace Connect architecture (C186-C189,
 * C045), all gated by `workspaceConnectEnabled()`. No Stripe or database
 * access here on purpose — a decision this consequential (where billing
 * money comes from, whether an existing workspace's payouts silently change
 * behavior) is read and tested without a payment processor in the loop, same
 * discipline as `deposit-return.ts` / `charge-refund.ts`.
 */

export type BillingFundingDecision =
  | { source: "balance"; amountCents: number }
  | { source: "card"; amountCents: number; reason: "balance_disabled" | "insufficient_balance" }
  | { source: "blocked"; reason: "no_card_on_file"; shortfallCents: number };

/**
 * C045: what happens when a workspace's balance can't cover PropLane's own
 * plan/communication-credit billing. Captain's recommended option: fall back
 * to the card on file automatically. With the flag off, or with no balance
 * concept to check yet, billing already goes to the card today — this
 * function reproduces exactly that as `"balance_disabled"` rather than
 * inventing new behavior for the disabled case.
 */
export function decideBillingFundingSource(input: {
  amountCents: number;
  workspaceConnectEnabled: boolean;
  availableBalanceCents: number;
  hasCardOnFile: boolean;
}): BillingFundingDecision {
  if (input.amountCents <= 0) return { source: "balance", amountCents: 0 };
  if (!input.workspaceConnectEnabled) {
    return { source: "card", amountCents: input.amountCents, reason: "balance_disabled" };
  }
  if (input.availableBalanceCents >= input.amountCents) {
    return { source: "balance", amountCents: input.amountCents };
  }
  if (input.hasCardOnFile) {
    return { source: "card", amountCents: input.amountCents, reason: "insufficient_balance" };
  }
  return {
    source: "blocked",
    reason: "no_card_on_file",
    shortfallCents: input.amountCents - Math.max(0, input.availableBalanceCents),
  };
}

/**
 * C189: existing managers are on automatic weekly Friday payouts today
 * (`createAxisConnectAccount`, `stripe-connect.ts`). Captain's recommended
 * option: new workspaces are Withdraw-only (manual) from the start; an
 * EXISTING workspace only switches off automatic payouts after its owner
 * explicitly confirms once — nobody's rent should suddenly stop arriving
 * without them knowing. A brand-new workspace never needs this confirmation
 * because it was never on automatic payouts to begin with.
 */
export function decideAutoPayoutSwitchRequiresConfirmation(input: {
  workspaceConnectEnabled: boolean;
  isExistingWorkspaceOnAutomaticPayouts: boolean;
  alreadyConfirmed: boolean;
}): boolean {
  if (!input.workspaceConnectEnabled) return false;
  if (!input.isExistingWorkspaceOnAutomaticPayouts) return false;
  return !input.alreadyConfirmed;
}

/**
 * The payout mode a workspace should be recorded with, given C189's rule. A
 * brand-new workspace (no prior automatic-payout history) starts manual
 * outright; an existing one stays on whatever it already has until its owner
 * confirms the one-time switch.
 */
export function nextWorkspacePayoutMode(input: {
  isExistingWorkspaceOnAutomaticPayouts: boolean;
  switchConfirmed: boolean;
}): "manual" | "automatic" {
  if (!input.isExistingWorkspaceOnAutomaticPayouts) return "manual";
  return input.switchConfirmed ? "manual" : "automatic";
}
