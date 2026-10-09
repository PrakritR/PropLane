import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(() => ({ subscriptions: { retrieve: vi.fn(async (id: string) => ({
    id, status: "active", customer: id === "sub_owner" ? "cus_owner" : "cus_test_123",
    items: { data: [{ price: { id: "price_overage" } }, { price: { id: "price_pro_monthly" } }] },
  })) }, prices: { retrieve: vi.fn(async (id: string) => ({
    id, currency: "usd", type: "recurring", recurring: { interval: "month", interval_count: 1 },
    product: id === "price_overage" ? "prod_overage" : "prod_pro",
  })) }, products: { retrieve: vi.fn(async (id: string) => ({ metadata: { axis_plan: id === "prod_pro" ? "axis_pro" : "axis_overage" } })) } })),
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

import {
  adoptPaidPortalCheckoutForOwner,
  checkoutSessionIndicatesPaidPurchase,
  recordPaidManagerCheckoutSession,
  resolveManagerCheckoutPurchase,
} from "@/lib/manager-purchase-from-session";
import { isWaiverGrantedManagerPurchase } from "@/lib/manager-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { mockCheckoutSession } from "../mocks/stripe/events";

describe("manager-purchase-from-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects paid checkout sessions", () => {
    expect(checkoutSessionIndicatesPaidPurchase(mockCheckoutSession())).toBe(true);
    expect(checkoutSessionIndicatesPaidPurchase(mockCheckoutSession({ payment_status: "unpaid", status: "open" }))).toBe(
      false,
    );
  });

  it("keeps a completed subscription with unpaid payment status pending", () => {
    expect(
      checkoutSessionIndicatesPaidPurchase(
        mockCheckoutSession({ payment_status: "unpaid", status: "complete", mode: "subscription" }),
      ),
    ).toBe(false);
  });

  it("fulfills a durable guest reservation without inventing an auth owner", async () => {
    const update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    const query = {
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "purchase-1", user_id: null, manager_id: "MGR-TEST", email: "manager@example.com" },
        error: null,
      }),
    };
    query.eq.mockReturnValue(query);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => query), update })),
    } as never);

    await recordPaidManagerCheckoutSession(
      mockCheckoutSession({
        id: "cs_test_guest",
        customer_email: "manager@example.com",
        metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-TEST" },
      }),
    );

    expect(update).toHaveBeenCalledWith(expect.not.objectContaining({ user_id: expect.anything() }));
    // This signed, previously reserved purchase keeps its captured terms if
    // its Price has since been retired from the current checkout catalog.
  });

  it("records a redeemed FREEFIRST in stripe_promotion_code and never in the waiver column", async () => {
    const update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    const query = {
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "purchase-1", user_id: null, manager_id: "MGR-TEST", email: "manager@example.com" },
        error: null,
      }),
    };
    query.eq.mockReturnValue(query);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => query), update })),
    } as never);

    await recordPaidManagerCheckoutSession(
      mockCheckoutSession({
        id: "cs_test_freefirst",
        customer_email: "manager@example.com",
        metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-TEST", promo: "freefirst" },
      }),
    );

    const patch = (update.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(patch.stripe_promotion_code).toBe("FREEFIRST");
    // promo_code is the payment-waiver column: a discount code there keeps paid access after cancelling.
    expect(patch).not.toHaveProperty("promo_code");
    expect(isWaiverGrantedManagerPurchase(patch.promo_code as string | undefined)).toBe(false);
  });

  it("does not let signed metadata replace a reservation's auth owner", async () => {
    const update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    const query = {
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "purchase-1", user_id: "owner-a", manager_id: "MGR-TEST", email: "manager@example.com" },
        error: null,
      }),
    };
    query.eq.mockReturnValue(query);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => query), update })),
    } as never);

    await expect(
      recordPaidManagerCheckoutSession(
        mockCheckoutSession({
          id: "cs_test_mismatch",
          customer_email: "manager@example.com",
          metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-TEST", userId: "owner-b" },
        }),
      ),
    ).rejects.toThrow("ownership");
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves an authenticated legacy session from its durable pending owner", async () => {
    const responses = [
      { data: null, error: null },
      { data: { id: "purchase-legacy", user_id: "owner-a", manager_id: "MGR-A", email: "a@example.com" }, error: null },
    ];
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      maybeSingle: vi.fn(async () => responses.shift()),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    const db = { from: vi.fn(() => query) } as never;

    await expect(resolveManagerCheckoutPurchase(db, mockCheckoutSession({
      id: "cs_legacy_auth",
      customer_email: "a@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-A", userId: "owner-a" },
    }))).resolves.toMatchObject({ id: "purchase-legacy", userId: "owner-a" });
    expect(query.eq).toHaveBeenNthCalledWith(1, "stripe_checkout_session_id", "cs_legacy_auth");
    expect(query.eq).toHaveBeenNthCalledWith(2, "user_id", "owner-a");
  });

  it("resolves a guest legacy session only when pending manager and email both match", async () => {
    const responses = [
      { data: null, error: null },
      { data: { id: "purchase-guest", user_id: null, manager_id: "MGR-G", email: "guest@example.com" }, error: null },
    ];
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      maybeSingle: vi.fn(async () => responses.shift()),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    const db = { from: vi.fn(() => query) } as never;

    await expect(resolveManagerCheckoutPurchase(db, mockCheckoutSession({
      id: "cs_legacy_guest",
      customer_email: "guest@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-G" },
    }))).resolves.toMatchObject({ id: "purchase-guest", userId: null });
  });

  it("rejects a legacy guest whose signed email does not match the pending row", async () => {
    const responses = [
      { data: null, error: null },
      { data: { id: "purchase-guest", user_id: null, manager_id: "MGR-G", email: "stored@example.com" }, error: null },
    ];
    const query = {
      select: vi.fn(), eq: vi.fn(), or: vi.fn(), maybeSingle: vi.fn(async () => responses.shift()),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);

    await expect(resolveManagerCheckoutPurchase({ from: vi.fn(() => query) } as never, mockCheckoutSession({
      id: "cs_legacy_guest_mismatch",
      customer_email: "attacker@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-G" },
    }))).rejects.toThrow("ownership");
  });

  it("adopts one actually paid legacy portal session only for its authenticated Free owner and billing customer", async () => {
    const purchase = { id: "purchase-1", user_id: "owner-a", email: "a@example.com", manager_id: "MGR-A",
      tier: "free", stripe_checkout_session_id: "axis_intent_pending", stripe_subscription_id: null };
    const update = vi.fn();
    const db = { from: vi.fn((table: string) => {
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query), is: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: table === "manager_purchases" ? purchase :
          table === "profiles" ? { manager_id: "MGR-A", email: "a@example.com" } :
            { stripe_customer_id: "cus_owner" }, error: null })),
        update: vi.fn((patch: Record<string, unknown>) => {
          update(patch);
          purchase.stripe_checkout_session_id = String(patch.stripe_checkout_session_id);
          return query;
        }),
      };
      return query;
    }) };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const session = mockCheckoutSession({ id: "cs_paid_legacy", mode: "subscription", payment_status: "paid", subscription: "sub_owner",
      client_reference_id: "owner-a", customer: "cus_owner", customer_email: "a@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-A", userId: "owner-a" } });
    await adoptPaidPortalCheckoutForOwner(session, "owner-a");
    expect(update).toHaveBeenCalledWith({ stripe_checkout_session_id: "cs_paid_legacy" });
    await adoptPaidPortalCheckoutForOwner(session, "owner-a");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("fulfills a reserved paid portal session at captured retired terms with an overage item first", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn(async () => ({ status: "active", customer: "cus_owner",
        items: { data: [{ price: { id: "price_overage" } }, { price: { id: "price_retired_pro" } }] } })) },
      prices: { retrieve: vi.fn(async (id: string) => ({ id, active: false, unit_amount: 2000,
        currency: "usd", type: "recurring", recurring: { interval: "month", interval_count: 1 },
        product: id === "price_overage" ? "prod_overage" : "prod_pro" })) },
      products: { retrieve: vi.fn(async (id: string) => ({ metadata: { axis_plan: id === "prod_pro" ? "axis_pro" : "axis_overage" } })) },
    };
    for (let i = 0; i < 10; i++) vi.mocked(getStripe).mockReturnValueOnce(stripe as never);
    const purchase = { id: "purchase-retired", user_id: "owner-a", manager_id: "MGR-A",
      email: "a@example.com", stripe_checkout_session_id: "cs_retired", tier: "free" };
    const paidUpdates: Record<string, unknown>[] = [];
    const db = { from: vi.fn((table: string) => {
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: table === "manager_purchases" ? purchase :
          table === "profiles" ? { manager_id: "MGR-A", email: "a@example.com" } :
            { stripe_customer_id: "cus_owner" }, error: null })),
        update: vi.fn((patch: Record<string, unknown>) => { paidUpdates.push(patch); return query; }),
        then: (resolve: (result: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      return query;
    }) };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const session = mockCheckoutSession({ id: "cs_retired", mode: "subscription", status: "complete",
      payment_status: "paid", subscription: "sub_retired", customer: "cus_owner",
      client_reference_id: "owner-a", customer_email: "a@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-A", userId: "owner-a" } });
    await adoptPaidPortalCheckoutForOwner(session, "owner-a");
    await recordPaidManagerCheckoutSession(session);
    expect(paidUpdates).toHaveLength(1);
    expect(paidUpdates[0]).toMatchObject({ stripe_checkout_session_id: "cs_retired", tier: "pro", billing: "monthly" });
    expect(stripe.prices.retrieve).toHaveBeenCalledWith("price_retired_pro");
  });

  it("creates an exact paid-session reservation for an authenticated Free manager missing a purchase row", async () => {
    const inserted = vi.fn();
    const db = { from: vi.fn((table: string) => {
      let insertMode = false;
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: table === "manager_purchases"
          ? (insertMode ? { id: "purchase-new" } : null)
          : table === "profiles" ? { manager_id: "MGR-A", email: "a@example.com" }
            : { stripe_customer_id: "cus_owner" }, error: null })),
        insert: vi.fn((row: Record<string, unknown>) => { insertMode = true; inserted(row); return query; }),
      };
      return query;
    }) };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const session = mockCheckoutSession({ id: "cs_paid_no_purchase", mode: "subscription", status: "complete",
      payment_status: "paid", subscription: "sub_owner", customer: "cus_owner", client_reference_id: "owner-a",
      customer_email: "a@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-A", userId: "owner-a" } });
    await adoptPaidPortalCheckoutForOwner(session, "owner-a");
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "owner-a", manager_id: "MGR-A", email: "a@example.com", stripe_checkout_session_id: "cs_paid_no_purchase",
    }));
  });

  it("does not adopt an unpaid or wrong-owner legacy portal session", async () => {
    const db = { from: vi.fn() };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    await adoptPaidPortalCheckoutForOwner(mockCheckoutSession({ payment_status: "unpaid",
      client_reference_id: "owner-a", metadata: { manager_id: "MGR-A", userId: "owner-a" } }), "owner-a");
    await adoptPaidPortalCheckoutForOwner(mockCheckoutSession({ payment_status: "paid",
      client_reference_id: "other", metadata: { manager_id: "MGR-A", userId: "owner-a" } }), "owner-a");
    expect(db.from).not.toHaveBeenCalled();
  });
});
