/**
 * The routing decision for owner-managed rent. Pure: every fact it needs is passed in, so the rules are
 * testable and the database-backed resolver (`checkout-routing.server.ts`) only gathers facts.
 */

import { isOwnerRoutedRentKind, type OwnerAgreementTerms } from "@/lib/owner-management/fee-math";

export type OwnerAgreementStatus = "draft" | "active" | "ended";

export type OwnerAgreementFacts = {
  id: string;
  propertyId: string;
  managerUserId: string;
  ownerUserId: string;
  status: OwnerAgreementStatus;
  startsOn: string;
  endsOn: string | null;
  terms: OwnerAgreementTerms;
};

export type OwnerRoutingDecision =
  /** No active agreement (or nothing routable): today's flow, byte for byte. */
  | { kind: "none"; reason: "no_agreement" | "not_active" | "no_routed_kinds" }
  /** The cart mixes routed and unrouted kinds, or autopay: refuse rather than guess a destination. */
  | { kind: "refuse"; status: number; code: string; error: string }
  /** Active agreement, owner not payout-ready: workspace flow, the owner's share is booked as owed. */
  | { kind: "held"; agreement: OwnerAgreementFacts; reason: "owner_not_ready" | "owner_account_missing" }
  /** Destination charge to the owner's connected account. */
  | { kind: "owner_destination"; agreement: OwnerAgreementFacts; destinationAccountId: string };

export type OwnerRoutingInput = {
  /** The house's agreement, whatever its status (the active one if there is one). Null = none. */
  agreement: OwnerAgreementFacts | null;
  /** Kinds of every charge in the cart. */
  chargeKinds: readonly string[];
  /** Today's date in Pacific, `YYYY-MM-DD`. */
  todayPacific: string;
  /** The owner's connected account id when transfers are active and payouts enabled, else null. */
  readyDestinationAccountId: string | null;
  /** The owner has no connected account at all. */
  ownerHasNoAccount?: boolean;
  /** An off-session autopay run: routed houses are not supported there yet. */
  autopay?: boolean;
};

export const MIXED_OWNER_ROUTING_ERROR =
  "This house's rent is paid to its owner. Pay the rent on its own, separately from the other charges.";
export const OWNER_AUTOPAY_REFUSAL =
  "Autopay is not available for this house yet. Pay this month's rent from Payments.";

export function agreementActiveOn(agreement: OwnerAgreementFacts, todayPacific: string): boolean {
  if (agreement.status !== "active") return false;
  if (agreement.startsOn > todayPacific) return false;
  if (agreement.endsOn && agreement.endsOn < todayPacific) return false;
  return true;
}

export function decideOwnerRouting(input: OwnerRoutingInput): OwnerRoutingDecision {
  const { agreement } = input;
  if (!agreement) return { kind: "none", reason: "no_agreement" };
  if (!agreementActiveOn(agreement, input.todayPacific)) return { kind: "none", reason: "not_active" };

  const routed = input.chargeKinds.filter(isOwnerRoutedRentKind).length;
  if (routed === 0) return { kind: "none", reason: "no_routed_kinds" };
  if (routed !== input.chargeKinds.length) {
    return { kind: "refuse", status: 422, code: "MIXED_OWNER_ROUTING", error: MIXED_OWNER_ROUTING_ERROR };
  }
  if (input.autopay) {
    return { kind: "refuse", status: 409, code: "OWNER_AUTOPAY_UNSUPPORTED", error: OWNER_AUTOPAY_REFUSAL };
  }
  const account = input.readyDestinationAccountId?.trim() || "";
  if (!account) {
    return { kind: "held", agreement, reason: input.ownerHasNoAccount ? "owner_account_missing" : "owner_not_ready" };
  }
  return { kind: "owner_destination", agreement, destinationAccountId: account };
}
