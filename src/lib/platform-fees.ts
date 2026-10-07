import { normalizeManagerSkuTier, type ManagerSkuTier } from "@/lib/manager-access";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";

/**
 * Platform take rates when using Stripe Connect destination charges.
 * Basis points = hundredths of a percent; 100 bps = 1%.
 *
 * Stripe: pass `application_fee_amount` (integer cents) on Checkout Sessions /
 * PaymentIntents created with `transfer_data.destination` = connected account id.
 */

export type PlatformFeeKind = "application_fee" | "rent";

// PropLane never takes a fee from resident/applicant transactions on ANY tier,
// and absorbs Stripe's processing cost on top of that, so residents and
// applicants pay exact face value. All take rates are 0 bps.
export const PLATFORM_FEE_BPS_BY_TIER: Record<ManagerSkuTier, Record<PlatformFeeKind, number>> = {
  free: {
    application_fee: 0,
    rent: 0,
  },
  pro: {
    application_fee: 0,
    rent: 0,
  },
  business: {
    application_fee: 0,
    rent: 0,
  },
};

export function platformFeeBpsForTier(tier: string | null | undefined, kind: PlatformFeeKind): number {
  const normalized = normalizeManagerSkuTier(tier) ?? "free";
  return PLATFORM_FEE_BPS_BY_TIER[normalized][kind];
}

export function platformApplicationFeeBps(tier?: string | null): number {
  return platformFeeBpsForTier(tier, "application_fee");
}

export function platformRentBps(tier?: string | null): number {
  return platformFeeBpsForTier(tier, "rent");
}

/** Integer cents taken by the platform from a gross charge (floor). */
export function platformFeeCents(grossAmountCents: number, kind: PlatformFeeKind, tier?: string | null): number {
  if (!Number.isFinite(grossAmountCents) || grossAmountCents <= 0) return 0;
  const bps = platformFeeBpsForTier(tier, kind);
  return Math.floor((grossAmountCents * bps) / 10000);
}

/** Public labels for UI (e.g. 0.5 and 0.25). */
export function platformFeeDisplayPercents(tier?: string | null): { applicationFee: number; rent: number } {
  return {
    applicationFee: platformApplicationFeeBps(tier) / 100,
    rent: platformRentBps(tier) / 100,
  };
}

// ---------------------------------------------------------------------------
// Vendor pay take rate (VENDOR_BANKING_ENABLED, night/vendor-banking).
//
// Distinct from the resident/applicant take rates above (which stay 0 on
// every tier): this is PropLane's cut of a MANAGER → VENDOR payment,
// captain-approved 2026-09-27 at 3% (VD56). Server-side constant, never
// client-supplied. Gated on the flag so a checkout built before the flag
// existed (or with it off) keeps charging exactly what it charges today —
// see work-order-approve-pay.server.ts's startVendorPayCheckout, which adds
// this on top of Stripe's own processing cost as application_fee_amount.
// ---------------------------------------------------------------------------

export const VENDOR_PAY_FEE_BPS = 300; // 3% — VD56, captain-approved 2026-09-27

/** 300 when the flag is on, 0 when off — flag-off callers see zero fee, byte-for-byte. */
export function vendorPayFeeBps(): number {
  return vendorBankingEnabled() ? VENDOR_PAY_FEE_BPS : 0;
}

/**
 * PropLane's cut of a gross vendor payment, in integer cents. Floors to the
 * cent, is never negative, and never exceeds the gross amount it's a
 * percentage of (both guaranteed by construction here, asserted again by the
 * caller before it ever reaches Stripe).
 */
export function vendorPayFeeCents(grossAmountCents: number): number {
  if (!Number.isFinite(grossAmountCents) || grossAmountCents <= 0) return 0;
  const bps = vendorPayFeeBps();
  if (bps <= 0) return 0;
  const fee = Math.floor((Math.round(grossAmountCents) * bps) / 10_000);
  return Math.min(Math.max(fee, 0), Math.round(grossAmountCents));
}

/** Public label for UI ("3% of each payment"). */
export function vendorPayFeeDisplayPercent(): number {
  return vendorPayFeeBps() / 100;
}

/** The one vendor-facing name for the fee. Every label, statement kind and receipt line reads this. */
export const PROPLANE_SERVICE_FEE_LABEL = "PropLane service fee";

/** Statement-line description for the fee debit; the percent comes from the rate constant, never a literal. */
export function vendorServiceFeeDescription(): string {
  return `${PROPLANE_SERVICE_FEE_LABEL} (${VENDOR_PAY_FEE_BPS / 100}%)`;
}

/**
 * The only rails that carry the vendor service fee in this build. The fee is
 * a Stripe application fee on the manager's Checkout, frozen with the
 * provider terms at checkout time (`pendingVendorPay.providerTerms` /
 * `freeze_vendor_invoice_stripe_checkout_terms`) and booked at settlement.
 *
 * Offline/manual settles and PropLane-balance payments carry NO service fee
 * (`platform_fee_cents` stays 0 and no revenue entry is written). The balance
 * rail is deliberately deferred: taking the fee there needs a
 * source-classification change in the balance-move SQL, which cannot be
 * verified without applying a migration. Never infer a fee on those rails.
 */
export const VENDOR_SERVICE_FEE_RAILS = ["stripe_checkout"] as const;

// ---------------------------------------------------------------------------
// Vendor Instant-withdraw fee (VENDOR_BANKING_ENABLED).
//
// Distinct from the manager/vendor-shared 1% INSTANT_PAYOUT_FEE_BPS in
// stripe-payouts.ts (Stripe's real Connect Instant Payouts cost, unchanged
// for everyone). This is PropLane's OWN vendor-specific Instant-withdraw
// fee on top — studio ground truth: payout-withdraw-sheet.tsx, 1.5%, a
// $0.50 minimum. Applied only by the vendor withdraw path when this flag is
// on; off, vendor Instant withdrawals keep using the shared 1% fee exactly
// as before.
// ---------------------------------------------------------------------------

export const VENDOR_INSTANT_WITHDRAW_FEE_BPS = 150; // 1.5%
export const VENDOR_INSTANT_WITHDRAW_FEE_MIN_CENTS = 50; // $0.50 floor

/**
 * The Instant payout is for the NET amount, so the fee would stay inside the vendor's connected
 * account. Nothing in the codebase moves money from a connected account to the platform for a
 * fee (the only claw-back is a transfer reversal tied to a specific hold transfer, which would
 * corrupt refund bookkeeping), so the fee cannot be collected. Until a real collect mechanism
 * exists this is false: the fee is quoted as $0, charged as $0 and never booked, so the books
 * can never claim money that did not move. Flip only together with a collect step that runs
 * (idempotency key tied to the withdrawal id) BEFORE the ledger line is written.
 */
export const VENDOR_INSTANT_FEE_COLLECTABLE: boolean = false;

/**
 * The ONE Instant-withdraw fee formula (1.5%, $0.50 minimum). Pure and flag-free
 * so the Withdraw sheet quotes exactly what the server charges: the server
 * (`vendorInstantWithdrawFeeCents`, flag-gated) and every client quote both call
 * this, and the sheet's label comes from `VENDOR_INSTANT_WITHDRAW_FEE_LABEL`.
 */
export function vendorInstantWithdrawFeeQuoteCents(amountCents: number): number {
  if (!VENDOR_INSTANT_FEE_COLLECTABLE) return 0;
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  const raw = Math.round((Math.round(amountCents) * VENDOR_INSTANT_WITHDRAW_FEE_BPS) / 10_000);
  return Math.max(VENDOR_INSTANT_WITHDRAW_FEE_MIN_CENTS, raw);
}

/** "1.5% fee · $0.50 minimum" — derived from the constants, never typed twice. */
export const VENDOR_INSTANT_WITHDRAW_FEE_LABEL = VENDOR_INSTANT_FEE_COLLECTABLE
  ? `${VENDOR_INSTANT_WITHDRAW_FEE_BPS / 100}% fee · $${(VENDOR_INSTANT_WITHDRAW_FEE_MIN_CENTS / 100).toFixed(2)} minimum`
  : "No PropLane fee";

export function vendorInstantWithdrawFeeCents(amountCents: number): number {
  if (!vendorBankingEnabled()) return 0;
  return vendorInstantWithdrawFeeQuoteCents(amountCents);
}

/** Short copy for pricing / plan cards. */
export function axisResidentPaymentFeePlanLine(tier: ManagerSkuTier): string {
  const pct = platformRentBps(tier) / 100;
  if (pct <= 0) {
    return "No PropLane fee on resident online payments — residents pay face value, PropLane covers payment processing";
  }
  return `${pct}% PropLane fee on resident online payments (PropLane covers payment processing)`;
}
