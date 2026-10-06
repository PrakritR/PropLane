/**
 * Master switch for vendor banking (captain-approved studio VD39–VD59,
 * 2026-09-27): the 3% vendor take rate, manual payout schedule for new
 * vendor Connect accounts, the 90-day hold-expiry job, the vendor refund
 * route, the balance/statement/reconciliation surface, and the new UI.
 *
 * Default ON (captain, 2026-09-28 — the promote that ships this applies
 * `20260927180000_vendor_banking` first, so the schema is always there by
 * the time this flag can read on). Set `VENDOR_BANKING_ENABLED=0` (or
 * `false` / `off`) in an environment to fall back to the pre-feature
 * behavior: no new row is ever written to `vendor_banking_*` or
 * `platform_fee_cents` and the fee/schedule math returns 0 / unchanged. See
 * the coordination addendum in the build brief: this is the ONE flag every
 * vendor-banking behavior change reads.
 */
export function vendorBankingEnabled(): boolean {
  const raw = process.env.VENDOR_BANKING_ENABLED?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Vendor-initiated refunds to a manager. Default OFF: the existing path
 * (`refund.server.ts`) refunds central 'hold' captures outside the reserved
 * central refund rail, which the webhook refuses and which wedges the hold.
 * Stays off until the refund runs through `runReservedPlatformMoneyRefund`.
 * `VENDOR_REFUNDS_ENABLED=1` re-enables it (tests / a rebuilt path only).
 */
export function vendorRefundsEnabled(): boolean {
  const raw = process.env.VENDOR_REFUNDS_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}
