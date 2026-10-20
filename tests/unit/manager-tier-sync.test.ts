import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

import { applyExpiredManagerPurchaseDowngrade, revokeUnauthorizedManagerPaidTier } from "@/lib/manager-tier-sync";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Row = Record<string, unknown>;

/**
 * Builds a fake service-role client over `manager_purchases` whose single SELECT
 * resolves to `row` and whose UPDATE is recorded. Both downgrade helpers do exactly
 * one `.from().select().eq().maybeSingle()` followed by an optional
 * `.from().update().eq()` — the spy lets us assert whether a destructive write fired.
 */
function fakeClient(row: Row | null) {
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({ eq: updateEq }));
  const selectEq = vi.fn();
  const builder = {
    eq: selectEq,
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
  };
  selectEq.mockReturnValue(builder);
  const select = vi.fn(() => builder);
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
    from: vi.fn(() => ({ select, update })),
  } as never);
  return { update, updateEq, selectEq };
}

describe("manager-tier-sync waiver-grant protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("revokeUnauthorizedManagerPaidTier", () => {
    it("never revokes a payment-waiver / coupon grant", async () => {
      const { update } = fakeClient({
        id: "purchase-1",
        tier: "pro",
        billing: "free",
        stripe_subscription_id: null,
        stripe_checkout_session_id: "cs_test_normal",
        promo_code: "FREE100",
      });

      await expect(revokeUnauthorizedManagerPaidTier("user-1")).resolves.toBe(false);
      expect(update).not.toHaveBeenCalled();
    });

    it("never revokes an Apple IAP grant (billing=apple + original transaction id)", async () => {
      // The #1 integration landmine: an Apple-billed paid tier has no Stripe
      // subscription, so without this guard the sweep would downgrade a paying
      // iOS customer on the very next entitlement read.
      const { update } = fakeClient({
        id: "purchase-1",
        tier: "business",
        billing: "apple",
        stripe_subscription_id: null,
        stripe_checkout_session_id: "apple_iap_1000000123456789",
        promo_code: null,
        apple_original_transaction_id: "1000000123456789",
      });

      await expect(revokeUnauthorizedManagerPaidTier("user-1")).resolves.toBe(false);
      expect(update).not.toHaveBeenCalled();
    });

    it("still revokes a bare billing=apple row with NO transaction id (not an authorized grant)", async () => {
      const { update } = fakeClient({
        id: "purchase-1",
        tier: "pro",
        billing: "apple",
        stripe_subscription_id: null,
        stripe_checkout_session_id: "cs_test_normal",
        promo_code: null,
        apple_original_transaction_id: null,
      });

      await expect(revokeUnauthorizedManagerPaidTier("user-1")).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith({ tier: "free", billing: "free", stripe_subscription_id: null, subscription_status: null, first_paid_at: null });
    });

    it("revokes a self-assigned paid tier with no Stripe, admin, or waiver backing", async () => {
      const { update, updateEq, selectEq } = fakeClient({
        id: "purchase-1",
        tier: "pro",
        billing: "free",
        stripe_subscription_id: null,
        stripe_checkout_session_id: "cs_test_normal",
        promo_code: null,
      });

      await expect(revokeUnauthorizedManagerPaidTier("user-1")).resolves.toBe(true);
      expect(selectEq).toHaveBeenCalledWith("user_id", "user-1");
      expect(update).toHaveBeenCalledWith({ tier: "free", billing: "free", stripe_subscription_id: null, subscription_status: null, first_paid_at: null });
      expect(updateEq).toHaveBeenCalledWith("id", "purchase-1");
    });
  });

  describe("applyExpiredManagerPurchaseDowngrade", () => {
    it("never downgrades a payment-waiver / coupon grant, even when expired", async () => {
      const { update } = fakeClient({
        id: "purchase-1",
        tier: "pro",
        billing: "monthly",
        paid_at: "2000-01-01T00:00:00.000Z", // long past — would be expired without the waiver guard
        stripe_subscription_id: null,
        promo_code: "FREE100",
      });

      await expect(applyExpiredManagerPurchaseDowngrade("user-1")).resolves.toBe(false);
      expect(update).not.toHaveBeenCalled();
    });

    it("never date-expires an Apple IAP grant (expiry comes from App Store webhooks)", async () => {
      const { update } = fakeClient({
        id: "purchase-1",
        tier: "pro",
        billing: "apple",
        paid_at: "2000-01-01T00:00:00.000Z", // ancient — would look expired under date-math
        stripe_subscription_id: null,
        promo_code: null,
        apple_original_transaction_id: "1000000123456789",
      });

      await expect(applyExpiredManagerPurchaseDowngrade("user-1")).resolves.toBe(false);
      expect(update).not.toHaveBeenCalled();
    });

    it("downgrades an expired non-waiver period grant", async () => {
      const { update, updateEq, selectEq } = fakeClient({
        id: "purchase-1",
        tier: "pro",
        billing: "monthly",
        paid_at: "2000-01-01T00:00:00.000Z",
        stripe_subscription_id: null,
        promo_code: null,
      });

      await expect(applyExpiredManagerPurchaseDowngrade("user-1")).resolves.toBe(true);
      expect(selectEq).toHaveBeenCalledWith("user_id", "user-1");
      expect(update).toHaveBeenCalledWith({ tier: "free", billing: "free" });
      expect(updateEq).toHaveBeenCalledWith("id", "purchase-1");
    });
  });
});
