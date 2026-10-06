import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { assertResidentCheckoutAttemptTerms, assertResidentCheckoutSession,
  loadResidentManualAchAttemptForPaymentIntent, type ResidentCheckoutAttempt } from "@/lib/resident-checkout-claim.server";

vi.mock("server-only", () => ({}));

function fixture(): { attempt: ResidentCheckoutAttempt; session: Stripe.Checkout.Session } {
  const chargeIds = ["hc_a", "hc_b"];
  const attempt = {
    id: "attempt-1", attempt_token: "token-1", resident_user_id: "resident-1",
    resident_email: "resident@example.test", manager_user_id: "manager-1",
    charge_ids: chargeIds, charge_cents: [1000, 2000], subtotal_cents: 3000,
    payer_total_cents: 3000, recipient_net_cents: 3000, payment_method: "card" as const,
    currency: "usd" as const, stripe_session_id: "cs_1", stripe_payment_intent_id: null,
    status: "pending" as const, created_at: new Date().toISOString(),
    provider_params: {
      idempotencyKey: "resident-checkout:token-1", residentEmail: "resident@example.test",
      mode: "embedded" as const, paymentMethod: "card" as const,
      lineItems: [{ amountCents: 1000, productName: "Rent" }, { amountCents: 2000, productName: "Utilities" }],
      metadata: { purpose: "household_charge", source_arbitration_v: "1",
        resident_attempt_token: "token-1", charge_id: "hc_a", charge_ids: "hc_a,hc_b",
        manager_user_id: "manager-1", resident_email: "resident@example.test" },
      destinationAccountId: null, fundingModel: "connect_destination" as const,
      feePayer: "proplane" as const, forceExplicitCard: true,
      fixedFeeBreakdown: { serviceFeeCents: 0, residentAddedFeeCents: 0,
        applicationFeeCents: 0, totalCents: 3000, managerPayoutCents: 3000 },
    },
  } satisfies ResidentCheckoutAttempt;
  const session = {
    id: "cs_1", mode: "payment", currency: "usd", amount_total: 3000,
    payment_status: "paid", status: "complete", payment_intent: "pi_1",
    metadata: { ...attempt.provider_params.metadata, payment_method: "card",
      subtotal_cents: "3000", processing_fee_cents: "0", manager_payout_cents: "3000",
      fee_payer: "proplane", platform_hold: "1", hold_amount_cents: "3000" },
  } as unknown as Stripe.Checkout.Session;
  return { attempt, session };
}

describe("resident checkout exact source terms", () => {
  it("accepts the frozen cart, owner, payer total, method and central hold source", () => {
    const { attempt, session } = fixture();
    expect(assertResidentCheckoutAttemptTerms(attempt)).toBe(attempt.provider_params);
    expect(() => assertResidentCheckoutSession(attempt, session)).not.toThrow();
  });

  it("resumes only the original resident's exact manual ACH PI", async () => {
    const { attempt } = fixture();
    attempt.payment_method = "ach";
    attempt.stripe_session_id = "pi_manual";
    attempt.provider_params.paymentMethod = "ach";
    attempt.provider_params.forceExplicitCard = false;
    attempt.provider_params.metadata = { ...attempt.provider_params.metadata,
      resident_payment_flow: "manual_ach", manual_ach: "1" };
    const pi = { id: "pi_manual", amount: 3000, currency: "usd", status: "requires_action",
      metadata: { ...attempt.provider_params.metadata,
        subtotal_cents: "3000", principal_cents: "3000", total_cents: "3000",
        processing_fee_cents: "0", manager_payout_cents: "3000", fee_payer: "proplane",
        platform_hold: "1", hold_amount_cents: "3000" } } as unknown as Stripe.PaymentIntent;
    const db = { from: () => { const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: attempt, error: null }) }; return query; } } as never;
    await expect(loadResidentManualAchAttemptForPaymentIntent(db, pi, "resident-1"))
      .resolves.toMatchObject({ id: attempt.id });
    await expect(loadResidentManualAchAttemptForPaymentIntent(db, pi, "replacement-user"))
      .rejects.toThrow(/does not belong/);
    pi.metadata!.total_cents = "3100";
    await expect(loadResidentManualAchAttemptForPaymentIntent(db, pi, "resident-1"))
      .rejects.toThrow(/differs/);
  });

  it.each([
    ["manager", (session: Stripe.Checkout.Session) => { session.metadata!.manager_user_id = "other-manager"; }],
    ["cart", (session: Stripe.Checkout.Session) => { session.metadata!.charge_ids = "hc_a,hc_c"; }],
    ["method", (session: Stripe.Checkout.Session) => { session.metadata!.payment_method = "ach"; }],
    ["amount", (session: Stripe.Checkout.Session) => { session.amount_total = 3100; }],
    ["currency", (session: Stripe.Checkout.Session) => { session.currency = "eur"; }],
    ["session", (session: Stripe.Checkout.Session) => { session.id = "cs_other"; }],
    ["destination", (session: Stripe.Checkout.Session) => { session.metadata!.platform_hold = "0"; }],
  ])("rejects a %s mismatch", (_name, corrupt) => {
    const { attempt, session } = fixture();
    corrupt(session);
    expect(() => assertResidentCheckoutSession(attempt, session)).toThrow(/differs/);
  });

  it("rejects changed stored price, line principal, or provider routing on retry", () => {
    const { attempt } = fixture();
    attempt.provider_params.lineItems![0]!.amountCents = 1500;
    expect(() => assertResidentCheckoutAttemptTerms(attempt)).toThrow(/do not reconcile/);
    const routed = fixture().attempt;
    routed.provider_params.destinationAccountId = "acct_unfrozen";
    expect(() => assertResidentCheckoutAttemptTerms(routed)).toThrow(/do not reconcile/);
  });
});
