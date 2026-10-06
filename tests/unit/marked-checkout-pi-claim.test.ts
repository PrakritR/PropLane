import { describe, expect, it, vi } from "vitest";
import { assertMarkedCheckoutPaymentIntentClaim } from "@/lib/stripe-webhook-financials";

function fixture() {
  const token = "11111111-1111-4111-8111-111111111111";
  const metadata = {
    purpose: "household_charge", source_arbitration_v: "1",
    resident_attempt_token: token, charge_id: "charge-a", charge_ids: "charge-a",
    manager_user_id: "owner-a", resident_email: "resident@example.com",
    payment_method: "card", fee_payer: "resident",
    platform_hold: "1", hold_amount_cents: "100",
  };
  const attempt = {
    id: "attempt-a", attempt_token: token, resident_user_id: "resident-a",
    resident_email: "resident@example.com", manager_user_id: "owner-a",
    charge_ids: ["charge-a"], charge_cents: [100], subtotal_cents: 100,
    payer_total_cents: 105, recipient_net_cents: 100, payment_method: "card",
    currency: "usd", stripe_session_id: "cs_exact", stripe_payment_intent_id: null,
    status: "pending", provider_params: {
      residentEmail: "resident@example.com", paymentMethod: "card",
      destinationAccountId: null, fundingModel: "connect_destination",
      feePayer: "resident", forceExplicitCard: true,
      idempotencyKey: `resident-checkout:${token}`,
      metadata, lineItems: [{ amountCents: 100 }],
      fixedFeeBreakdown: { totalCents: 105, residentAddedFeeCents: 5,
        managerPayoutCents: 100, applicationFeeCents: 5 },
    },
  };
  const pi = { id: "pi_exact", currency: "usd", amount: 105, metadata,
    transfer_data: null, application_fee_amount: null };
  const session = { id: "cs_exact", mode: "payment", currency: "usd", amount_total: 105,
    payment_intent: "pi_exact", metadata: { ...metadata, subtotal_cents: "100",
      processing_fee_cents: "5", manager_payout_cents: "100" } };
  const db = { from: vi.fn(() => ({ select: () => ({ eq: () => ({
    maybeSingle: async () => ({ data: attempt, error: null }),
  }) }) })) };
  const list = vi.fn(async () => ({ data: [session], has_more: false }));
  const stripe = { checkout: { sessions: { list } } };
  return { attempt, pi, session, db, stripe, list };
}

describe("marked Checkout PaymentIntent alias", () => {
  it("attests the frozen card claim and exact provider-owned session without paid mutation", async () => {
    const f = fixture();
    await expect(assertMarkedCheckoutPaymentIntentClaim(f.db as never, f.stripe as never, f.pi as never))
      .resolves.toBeUndefined();
    expect(f.list).toHaveBeenCalledWith({ payment_intent: "pi_exact", limit: 2 });
  });

  it("rejects a copied marker, changed PI economics, or a foreign Checkout session", async () => {
    const f = fixture();
    f.pi.amount = 106;
    await expect(assertMarkedCheckoutPaymentIntentClaim(f.db as never, f.stripe as never, f.pi as never))
      .rejects.toThrow(/frozen claim/);
    expect(f.list).not.toHaveBeenCalled();
    f.pi.amount = 105;
    f.session.payment_intent = "pi_foreign";
    await expect(assertMarkedCheckoutPaymentIntentClaim(f.db as never, f.stripe as never, f.pi as never))
      .rejects.toThrow(/another PaymentIntent/);
    f.session.payment_intent = "pi_exact";
    f.session.id = "cs_foreign";
    await expect(assertMarkedCheckoutPaymentIntentClaim(f.db as never, f.stripe as never, f.pi as never))
      .rejects.toThrow(/saved attempt/);
  });
});
