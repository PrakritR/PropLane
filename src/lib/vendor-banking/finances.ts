/**
 * Vendor Finances (vendor-banking-1006, part A) — the pure derivation that turns
 * the ONE server snapshot (`GET /api/vendor/payouts/balance`) into every figure,
 * banner and disabled-reason the Finances section shows. Client-safe: no
 * `server-only`, no env reads. Every number on Balance & payouts, the Withdraw
 * sheet and the Payments tab's refund gate comes through here, so two screens
 * can never disagree.
 */

export type VendorFinancesSnapshotInput = {
  availableCents: number;
  withdrawableCents?: number;
  pendingCents: number;
  onTheWayCents: number;
  heldCents?: number;
  /** Cents frozen by open disputes (server-read). Leaves Available and shows under Held as "Disputed". */
  frozenDisputeCents?: number;
  releasePendingCents?: number;
  recoveryOutstandingCents?: number;
  recoveryReservedCents?: number;
  payoutReconciliationPending?: boolean;
  needsRelink?: boolean;
  setup: { ready: boolean; identity?: "done" | "needed" | "pending" | string; bank?: "done" | "needed" | string };
  bank?: unknown | null;
};

export type VendorFinancesFigures = {
  availableCents: number;
  pendingCents: number;
  heldCents: number;
  /** Why money is held — null when nothing is held. */
  heldReason: string | null;
  onTheWayCents: number;
  /** What the vendor owes PropLane (refund shortfall recovery plus any provider deficit). */
  owedToPropLaneCents: number;
};

export type VendorFinancesBannerAction = "add-bank" | "verify" | "relink" | null;

export type VendorFinancesBanner = {
  tone: "warning" | "info";
  message: string;
  action: VendorFinancesBannerAction;
  actionLabel: string | null;
};

/** What the vendor can actually withdraw: the account's available balance less money frozen by an open dispute. */
export function vendorWithdrawableCents(
  snapshot: Pick<VendorFinancesSnapshotInput, "availableCents" | "withdrawableCents" | "frozenDisputeCents">,
): number {
  return Math.max(0, (snapshot.withdrawableCents ?? snapshot.availableCents) - Math.max(0, snapshot.frozenDisputeCents ?? 0));
}

export function deriveVendorFinancesFigures(snapshot: VendorFinancesSnapshotInput): VendorFinancesFigures {
  const baseHeldCents = Math.max(0, snapshot.heldCents ?? 0);
  // Only the part of the freeze that actually came out of Available moves under Held; the rest
  // was already inside the platform hold and is counted there.
  const frozenFromAvailable = Math.min(
    Math.max(0, snapshot.frozenDisputeCents ?? 0),
    Math.max(0, snapshot.withdrawableCents ?? snapshot.availableCents),
  );
  const heldCents = baseHeldCents + frozenFromAvailable;
  const releasePending = Math.max(0, snapshot.releasePendingCents ?? 0);
  const providerDeficit = Math.max(0, -(snapshot.withdrawableCents ?? 0));
  const recovery = Math.max(0, snapshot.recoveryOutstandingCents ?? 0);
  let heldReason: string | null = null;
  if (baseHeldCents > 0) {
    if (!snapshot.setup.ready) {
      heldReason = snapshot.setup.bank === "needed" ? "Until you add a bank" : "Until your identity is verified";
    } else if (releasePending > 0) {
      heldReason = "Being released to your account";
    } else {
      heldReason = "Held by PropLane";
    }
  }
  if (frozenFromAvailable > 0) heldReason = heldReason ? `${heldReason} · Disputed` : "Disputed";
  return {
    availableCents: vendorWithdrawableCents(snapshot),
    pendingCents: Math.max(0, snapshot.pendingCents),
    heldCents,
    heldReason,
    onTheWayCents: Math.max(0, snapshot.onTheWayCents),
    owedToPropLaneCents: providerDeficit + recovery,
  };
}

/** The one banner above the figures: the exact reason money cannot move yet, and the one fix. Null when all is well. */
export function deriveVendorFinancesBanner(
  snapshot: VendorFinancesSnapshotInput,
  held = Math.max(0, snapshot.heldCents ?? 0),
): VendorFinancesBanner | null {
  if (snapshot.needsRelink) {
    return {
      tone: "warning",
      message: "Reconnect your Stripe account to move money.",
      action: "relink",
      actionLabel: "Reconnect",
    };
  }
  if (!snapshot.setup.ready) {
    const waiting = held > 0 ? ` ${formatCents(held)} is waiting for you.` : "";
    if (snapshot.setup.identity === "pending") {
      return { tone: "info", message: `Stripe is verifying your identity.${waiting}`, action: null, actionLabel: null };
    }
    if (snapshot.setup.bank === "needed" && snapshot.setup.identity === "done") {
      return { tone: "warning", message: `Add a bank account to withdraw.${waiting}`, action: "add-bank", actionLabel: "Add bank" };
    }
    return {
      tone: "warning",
      message: `Finish verifying your identity and bank to withdraw.${waiting}`,
      action: snapshot.setup.bank === "needed" ? "add-bank" : "verify",
      actionLabel: snapshot.setup.bank === "needed" ? "Add bank" : "Verify",
    };
  }
  if (snapshot.payoutReconciliationPending) {
    return { tone: "info", message: "Checking a prior withdrawal before you can withdraw again.", action: null, actionLabel: null };
  }
  return null;
}

/** Why Withdraw is disabled — a disabled button must always say why. Null means it is enabled. */
export function vendorWithdrawDisabledReason(
  snapshot: VendorFinancesSnapshotInput,
  hasPayableBank: boolean,
): string | null {
  if (snapshot.needsRelink) return "Reconnect your Stripe account first";
  if (!snapshot.setup.ready) return "Finish setting up payouts first";
  if (!hasPayableBank) return "Add a bank account first";
  if (snapshot.payoutReconciliationPending) return "Checking a prior withdrawal";
  if (vendorWithdrawableCents(snapshot) <= 0) return "Nothing available to withdraw";
  return null;
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** A payment is refundable only while some of its gross is still unrefunded and it actually settled. */
export function isVendorPaymentRefundable(
  payout: { status: string; amountCents: number; refundedGrossCents?: number | null } | null | undefined,
  refundsEnabled: boolean,
): boolean {
  if (!refundsEnabled || !payout) return false;
  if (payout.status !== "paid" && payout.status !== "partially_refunded") return false;
  return payout.amountCents - (payout.refundedGrossCents ?? 0) > 0;
}
