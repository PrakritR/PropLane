import { beforeEach, describe, expect, it, vi } from "vitest";

const { subscriptionsRetrieve } = vi.hoisted(() => ({ subscriptionsRetrieve: vi.fn() }));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ subscriptions: { retrieve: subscriptionsRetrieve } }),
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
    expect(update).toHaveBeenCalledWith({ tier: "free", billing: "free", stripe_subscription_id: null });
    expect(updateEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("preserves DB state on a transient Stripe error (no downgrade)", async () => {
    const { update } = fakeClient({ stripe_subscription_id: "sub_123", stripe_checkout_session_id: "cs_normal" });
    subscriptionsRetrieve.mockRejectedValueOnce({ type: "StripeRateLimitError", statusCode: 429 });

    await reconcileManagerPurchaseWithStripe("user-1");

    expect(subscriptionsRetrieve).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns early for admin-managed grants without ever calling Stripe", async () => {
    const { update } = fakeClient({ stripe_subscription_id: "sub_123", stripe_checkout_session_id: "admin_MGR-1" });

    await reconcileManagerPurchaseWithStripe("user-1");

    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
