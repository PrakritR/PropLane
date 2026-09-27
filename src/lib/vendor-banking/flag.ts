/**
 * Master switch for vendor banking (captain-approved studio VD39–VD59,
 * 2026-09-27): the 3% vendor take rate, manual payout schedule for new
 * vendor Connect accounts, the 90-day hold-expiry job, the vendor refund
 * route, the balance/statement/reconciliation surface, and the new UI.
 *
 * Default OFF. With it off, every call site gated on this flag behaves
 * exactly as it did before this feature existed — no new row is ever
 * written to `vendor_banking_*` or `platform_fee_cents` and the fee/schedule
 * math returns 0 / unchanged. See the coordination addendum in the build
 * brief: this is the ONE flag every vendor-banking behavior change reads.
 */
export function vendorBankingEnabled(): boolean {
  const raw = process.env.VENDOR_BANKING_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
