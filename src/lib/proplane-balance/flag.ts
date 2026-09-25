/**
 * Master switch for the whole PropLane balance ledger (one platform Stripe
 * account + an internal per-manager/vendor withdrawable balance). Default OFF —
 * with it off, every existing money path (destination charges, Connect
 * transfers, platform holds) behaves exactly as it did before this feature
 * existed. See .lavish/night/build-vendor-pay.md for the switch-on checklist.
 */
export function proplaneBalanceEnabled(): boolean {
  const raw = process.env.PROPLANE_BALANCE_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
