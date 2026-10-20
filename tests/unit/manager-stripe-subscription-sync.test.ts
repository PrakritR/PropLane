import { beforeEach, describe, expect, it, vi } from "vitest";

const { subscriptionsRetrieve, invoicesList } = vi.hoisted(() => ({ subscriptionsRetrieve: vi.fn(), invoicesList: vi.fn() }));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ subscriptions: { retrieve: subscriptionsRetrieve }, invoices: { list: invoicesList } }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

import {
  isDefinitiveStripeSubscriptionMissingError,
  reconcileManagerPurchaseWithStripe,
} from "@/lib/manager-stripe-subscription-sync";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

describe("isDefinitiveStripeSubscriptionMissingError", () => {
  it("treats resource_missing as definitive", () => {
    expect(isDefinitiveStripeSubscriptionMissingError({ code: "resource_missing", statusCode: 404 })).toBe(true);
    expect(isDefinitiveStripeSubscriptionMissingError({ type: "StripeInvalidRequestError", statusCode: 404 })).toBe(true);
  });

  it("does not downgrade on transient / non-authoritative errors", () => {
    // Network blip
    expect(isDefinitiveStripeSubscriptionMissingError(new Error("ECONNRESET"))).toBe(false);
    // Rate limit
    expect(isDefinitiveStripeSubscriptionMissingError({ type: "StripeRateLimitError", statusCode: 429 })).toBe(false);
    // Auth error after key rotation
    expect(
      isDefinitiveStripeSubscriptionMissingError({ type: "StripeAuthenticationError", statusCode: 401 }),
    ).toBe(false);
    // API outage
    expect(isDefinitiveStripeSubscriptionMissingError({ type: "StripeAPIError", statusCode: 500 })).toBe(false);
    // Non-404 invalid request (e.g. bad param) is not a missing subscription
    expect(
      isDefinitiveStripeSubscriptionMissingError({ type: "StripeInvalidRequestError", statusCode: 400 }),
    ).toBe(false);
    expect(isDefinitiveStripeSubscriptionMissingError(null)).toBe(false);
    expect(isDefinitiveStripeSubscriptionMissingError(undefined)).toBe(false);
    expect(isDefinitiveStripeSubscriptionMissingError("nope")).toBe(false);
  });
});

type PurchaseRow = { stripe_subscription_id: string | null; stripe_checkout_session_id: string | null };

/**
 * Fake service-role client whose SELECT resolves to `purchase` and whose UPDATE is
 * recorded. `reconcileManagerPurchaseWithStripe` reads the row, then on a definitive
 * Stripe miss writes `tier/billing/stripe_subscription_id` — the spy proves whether
 * that destructive write fired.
 */
function fakeClient(purchase: PurchaseRow) {
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({ eq: updateEq }));
  const selectEq = vi.fn();
  const builder = {
    eq: selectEq,
    maybeSingle: vi.fn().mockResolvedValue({ data: purchase, error: null }),
  };
  selectEq.mockReturnValue(builder);
  const select = vi.fn(() => builder);
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
    from: vi.fn(() => ({ select, update })),
  } as never);
  return { update, updateEq, selectEq };
}

describe("reconcileManagerPurchaseWithStripe downgrade flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downgrades to free when Stripe definitively reports the subscription is gone", async () => {
    const { update, updateEq } = fakeClient({
      stripe_subscription_id: "sub_123",
      stripe_checkout_session_id: "cs_normal",
    });
    subscriptionsRetrieve.mockRejectedValueOnce({ code: "resource_missing", statusCode: 404 });

    await reconcileManagerPurchaseWithStripe("user-1");

    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_123", { expand: ["items.data.price"] });
    expect(update).toHaveBeenCalledWith({ tier: "free", billing: "free", stripe_subscription_id: null, subscription_status: null, first_paid_at: null });
    expect(updateEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("preserves DB state on a transient Stripe error (no downgrade)", async () => {
    const { update } = fakeClient({ stripe_subscription_id: "sub_123", stripe_checkout_session_id: "cs_normal" });
    subscriptionsRetrieve.mockRejectedValueOnce({ type: "StripeRateLimitError", statusCode: 429 });

    await reconcileManagerPurchaseWithStripe("user-1");

    expect(subscriptionsRetrieve).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("records the live subscription's status, so a trialing plan is not stored as a paid one", async () => {
    // The managed view-only lock reads `subscription_status`: a Stripe subscription id alone is satisfied by a
    // card-on-file trial that has paid nothing. This write is the webhook's path too
    // (`customer.subscription.updated` -> reconcileManagerPurchaseByStripeSubscriptionId).
    vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_monthly");
    for (const status of ["trialing", "active"]) {
      const { update } = fakeClient({ stripe_subscription_id: "sub_123", stripe_checkout_session_id: "cs_normal" });
      subscriptionsRetrieve.mockResolvedValueOnce({
        id: "sub_123",
        status,
        items: { data: [{ price: { id: "price_pro_monthly" } }] },
      });

      await reconcileManagerPurchaseWithStripe("user-1");

      expect(update).toHaveBeenCalledWith({
        tier: "pro",
        billing: "monthly",
        stripe_subscription_id: "sub_123",
        subscription_status: status,
      });
    }
    vi.unstubAllEnvs();
  });

  describe("first payment (the lock's proof that money moved)", () => {
    function firstPaidClient(firstPaidAt: string | null) {
      const markEq = vi.fn().mockResolvedValue({ error: null });
      const markIs = vi.fn(() => ({ eq: markEq }));
      const update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }), is: markIs }));
      const builder = {
        eq: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { stripe_subscription_id: "sub_123", stripe_checkout_session_id: "cs_normal", first_paid_at: firstPaidAt },
          error: null,
        }),
      };
      builder.eq.mockReturnValue(builder);
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => builder), update })) } as never);
      return { update, markIs, markEq };
    }
    const activeSub = (status: string) => ({ id: "sub_123", status, items: { data: [{ price: { id: "price_pro_monthly" } }] } });

    it("stamps first_paid_at (only while null) when a paid invoice collected money", async () => {
      vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_monthly");
      const { update, markIs, markEq } = firstPaidClient(null);
      subscriptionsRetrieve.mockResolvedValueOnce(activeSub("past_due"));
      invoicesList.mockResolvedValueOnce({ data: [{ amount_paid: 0 }, { amount_paid: 4900 }] });
      await reconcileManagerPurchaseWithStripe("user-1");
      expect(invoicesList).toHaveBeenCalledWith({ subscription: "sub_123", status: "paid", limit: 20 });
      expect(update).toHaveBeenCalledWith({ first_paid_at: expect.any(String) });
      expect(markIs).toHaveBeenCalledWith("first_paid_at", null);
      expect(markEq).toHaveBeenCalledWith("user_id", "user-1");
      vi.unstubAllEnvs();
    });

    it("never stamps for $0 invoices only (100%-off promotion, trial)", async () => {
      vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_monthly");
      const { markIs } = firstPaidClient(null);
      subscriptionsRetrieve.mockResolvedValueOnce(activeSub("active"));
      invoicesList.mockResolvedValueOnce({ data: [{ amount_paid: 0 }] });
      await reconcileManagerPurchaseWithStripe("user-1");
      expect(markIs).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    });

    it("does not ask Stripe again once stamped, and never looks at a trialing subscription", async () => {
      vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_monthly");
      firstPaidClient("2026-10-01T00:00:00Z");
      subscriptionsRetrieve.mockResolvedValueOnce(activeSub("active"));
      await reconcileManagerPurchaseWithStripe("user-1");
      expect(invoicesList).not.toHaveBeenCalled();
      firstPaidClient(null);
      subscriptionsRetrieve.mockResolvedValueOnce(activeSub("trialing"));
      await reconcileManagerPurchaseWithStripe("user-1");
      expect(invoicesList).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    });

    it("a Stripe failure leaves the column null (lock stays closed) without failing the reconcile", async () => {
      vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_monthly");
      const { markIs } = firstPaidClient(null);
      subscriptionsRetrieve.mockResolvedValueOnce(activeSub("active"));
      invoicesList.mockRejectedValueOnce(new Error("rate limited"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(reconcileManagerPurchaseWithStripe("user-1")).resolves.toBeUndefined();
      expect(markIs).not.toHaveBeenCalled();
      logged.mockRestore();
      vi.unstubAllEnvs();
    });
  });

  it("returns early for admin-managed grants without ever calling Stripe", async () => {
    const { update } = fakeClient({ stripe_subscription_id: "sub_123", stripe_checkout_session_id: "admin_MGR-1" });

    await reconcileManagerPurchaseWithStripe("user-1");

    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
