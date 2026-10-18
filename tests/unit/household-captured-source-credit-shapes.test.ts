/**
 * Reproduction harness for the browser-proof refusal: `household-charge-verify` marked the
 * charges paid and then `creditVerifiedHouseholdCheckoutSource` refused with "The payment
 * source needs review."
 *
 * Every shape here is built the way the real flow builds it — the Checkout metadata from
 * `createHouseholdChargeCheckout` + `buildAxisAchCheckoutSession` (hold path: no destination
 * account, so `platform_hold: "1"` and no `application_fee_amount`), the economics from
 * `residentServiceFeeBreakdown`, and the stored rows the way
 * `settle_resident_checkout_attempt` leaves them (`paidAmountCents` = the reserved
 * per-charge cents, `balanceLabel` "$0.00", `stripeCheckoutSessionId` = the session id).
 *
 * A failure here names the refusal, which is the whole point: the function has ~15
 * fail-closed throws and the route only ever reported the generic sentence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { residentServiceFeeBreakdown } from "@/lib/payment-policy";
import type { ServiceFeePayer } from "@/lib/payment-policy";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe-ledger-fees", () => ({
  enrichLedgerPaymentFromStripeCharge: vi.fn(async () => undefined),
}));
const release = vi.hoisted(() => ({
  throws: null as Error | null,
  settleThrows: null as Error | null,
  calls: 0,
  reviews: [] as { stage?: string; surface?: string; sourceId?: string; reason?: string }[],
}));
vi.mock("@/lib/platform-hold-release.server", () => ({
  verifyPlatformHoldSourceRefundHistory: vi.fn(async () => undefined),
  releaseVerifiedPlatformHoldsForOwner: vi.fn(async () => {
    release.calls += 1;
    if (release.throws) throw release.throws;
  }),
}));
vi.mock("@/lib/platform-owner-recovery.server", () => ({
  settleClearedPlatformOwnerRecovery: vi.fn(async () => {
    if (release.settleThrows) throw release.settleThrows;
  }),
  verifiedCapturedChargeAvailability: vi.fn(async () => ({ availableOn: null })),
}));
vi.mock("@/lib/household-source-review.server", () => ({
  recordHouseholdSourceReviewNeeded: vi.fn(
    async (
      _db: unknown,
      input: { stage?: string; surface?: string; sourceId?: string; error?: unknown },
    ) => {
      release.reviews.push({
        stage: input.stage,
        surface: input.surface,
        sourceId: input.sourceId,
        reason: input.error instanceof Error ? input.error.message : String(input.error),
      });
      return { recorded: true, reason: "" };
    },
  ),
}));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  findPlatformHold: vi.fn(async () => null),
  findPlatformHoldByPaymentIntent: vi.fn(async () => null),
}));

const { creditVerifiedHouseholdCheckoutSource } = await import("@/lib/household-captured-source.server");

beforeEach(() => {
  release.throws = null;
  release.settleThrows = null;
  release.calls = 0;
  release.reviews.length = 0;
});

const MANAGER = "11111111-1111-4111-8111-111111111111";
const SESSION = "cs_test_browserproof";
const PI = "pi_test_browserproof";
const STRIPE_CHARGE = "ch_test_browserproof";

type Cart = { id: string; kind: string; amountLabel: string; cents: number }[];

/** The Checkout session + PaymentIntent + Charge Stripe hands back for a hold-path capture. */
function providerObjects(cart: Cart, feePayer: ServiceFeePayer) {
  const subtotal = cart.reduce((sum, row) => sum + row.cents, 0);
  const fee = residentServiceFeeBreakdown(subtotal, "card", feePayer);
  const metadata: Record<string, string> = {
    purpose: "household_charge",
    source_arbitration_v: "1",
    charge_id: cart[0]!.id,
    charge_ids: cart.map((row) => row.id).join(","),
    manager_user_id: MANAGER,
    resident_email: "resident@example.test",
    property_id: "prop-1",
    bulk: cart.length > 1 ? "true" : "false",
    resident_attempt_token: "11111111-2222-4222-8222-222222222222",
    payment_method: "card",
    manager_tier: "paid",
    fee_payer: feePayer,
    subtotal_cents: String(subtotal),
    processing_fee_cents: String(fee.residentAddedFeeCents),
    axis_fee_cents: "0",
    service_fee_cents: String(fee.serviceFeeCents),
    manager_payout_cents: String(fee.managerPayoutCents),
    platform_hold: "1",
    hold_amount_cents: String(fee.managerPayoutCents),
  };
  const gross = subtotal + fee.residentAddedFeeCents;
  const session = {
    id: SESSION,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    amount_total: gross,
    payment_intent: PI,
    metadata,
  };
  const paymentIntent = {
    id: PI,
    status: "succeeded",
    currency: "usd",
    amount: gross,
    amount_received: gross,
    latest_charge: STRIPE_CHARGE,
    metadata,
  };
  const charge = {
    id: STRIPE_CHARGE,
    payment_intent: PI,
    paid: true,
    captured: true,
    status: "succeeded",
    currency: "usd",
    amount: gross,
    amount_refunded: 0,
    disputed: false,
    refunded: false,
  };
  return { session, paymentIntent, charge, subtotal, fee };
}

function stripeFor(objects: ReturnType<typeof providerObjects>) {
  return {
    paymentIntents: { retrieve: async () => objects.paymentIntent },
    charges: { retrieve: async () => objects.charge },
    refunds: { list: async () => ({ data: [], has_more: false }) },
  };
}

/** The charge rows exactly as `settle_resident_checkout_attempt` leaves them. */
function dbFor(cart: Cart, rpc: { error?: { message: string } | null; holdId?: string } = {}) {
  const rows = cart.map((row) => ({
    id: row.id,
    manager_user_id: MANAGER,
    kind: row.kind,
    status: "paid",
    row_data: {
      id: row.id,
      managerUserId: MANAGER,
      residentEmail: "resident@example.test",
      propertyId: "prop-1",
      kind: row.kind,
      title: "Rent",
      amountLabel: row.amountLabel,
      balanceLabel: "$0.00",
      status: "paid",
      paidAmountCents: row.cents,
      paidAt: "2026-10-17T00:00:00.000Z",
      stripeCheckoutSessionId: SESSION,
      stripePaymentStatus: "paid",
      blocksLeaseUntilPaid: false,
    },
  }));
  const calls: { components?: unknown; principal?: number; net?: number }[] = [];
  return {
    calls,
    db: {
      from() {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "eq", "in", "order", "limit"]) query[method] = () => query;
        query.maybeSingle = async () => ({ data: null, error: null });
        query.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
        return query;
      },
      async rpc(_name: string, args: Record<string, unknown>) {
        calls.push({
          components: args.p_components,
          principal: args.p_principal as number,
          net: args.p_original_net as number,
        });
        if (rpc.error) return { data: null, error: rpc.error };
        return { data: [{ hold_id: rpc.holdId ?? "hold-1", credited: true, reserved_cents: 0 }], error: null };
      },
    },
  };
}

async function credit(cart: Cart, feePayer: ServiceFeePayer) {
  const objects = providerObjects(cart, feePayer);
  const { db, calls } = dbFor(cart);
  await creditVerifiedHouseholdCheckoutSource(
    db as never,
    stripeFor(objects) as never,
    objects.session as never,
  );
  return { calls, ...objects };
}

describe("creditVerifiedHouseholdCheckoutSource on the shapes the resident flow produces", () => {
  it("credits a single rent charge when the resident pays the fee", async () => {
    const cart: Cart = [{ id: "hc_rent_1", kind: "rent", amountLabel: "$1,400.00", cents: 140000 }];
    const { calls, subtotal, fee } = await credit(cart, "resident");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.principal).toBe(subtotal);
    expect(calls[0]!.net).toBe(fee.managerPayoutCents);
    expect(calls[0]!.components).toEqual([
      { source_id: "hc_rent_1", kind: "rent", liability_class: "income", principal_cents: 140000, recipient_net_cents: 140000 },
    ]);
  });

  it("credits a single rent charge when the manager absorbs the fee", async () => {
    const cart: Cart = [{ id: "hc_rent_1", kind: "rent", amountLabel: "$1,400.00", cents: 140000 }];
    const { calls, subtotal, fee } = await credit(cart, "manager");
    expect(calls[0]!.principal).toBe(subtotal);
    expect(calls[0]!.net).toBe(fee.managerPayoutCents);
    expect(fee.managerPayoutCents).toBeLessThan(subtotal);
    const components = calls[0]!.components as { recipient_net_cents: number }[];
    expect(components[0]!.recipient_net_cents).toBe(fee.managerPayoutCents);
  });

  it("splits a move-in cart's recipient fee across its lines and keeps deposits a liability", async () => {
    const cart: Cart = [
      { id: "hc_dep_1", kind: "security_deposit", amountLabel: "$1,150.00", cents: 115000 },
      { id: "hc_first_1", kind: "first_month_rent", amountLabel: "$1,400.00", cents: 140000 },
      { id: "hc_fee_1", kind: "move_in_fee", amountLabel: "$250.00", cents: 25000 },
    ];
    const { calls, subtotal, fee } = await credit(cart, "manager");
    const components = calls[0]!.components as {
      source_id: string;
      liability_class: string;
      principal_cents: number;
      recipient_net_cents: number;
    }[];
    expect(components.map((c) => c.source_id)).toEqual(["hc_dep_1", "hc_fee_1", "hc_first_1"]);
    expect(components.find((c) => c.source_id === "hc_dep_1")!.liability_class).toBe("deposit");
    expect(components.filter((c) => c.liability_class === "income")).toHaveLength(2);
    expect(components.reduce((sum, c) => sum + c.principal_cents, 0)).toBe(subtotal);
    expect(components.reduce((sum, c) => sum + c.recipient_net_cents, 0)).toBe(fee.managerPayoutCents);
  });

  it("classifies every household charge kind the way the database expects", async () => {
    // `verify_platform_hold_source` maps each kind to a liability class and refuses an
    // unmapped one, so a kind the migration does not list fails the credit for good.
    const kinds = [
      "application_fee", "holding_deposit", "stay_total", "first_month_rent", "prorated_rent",
      "prorated_last_month_rent", "rent", "utilities", "prorated_utilities",
      "prorated_last_month_utilities", "prorated_fee", "prorated_last_month_fee",
      "early_move_out_fee", "security_deposit", "move_in_fee", "lease_fee", "other_cost",
      "payment_at_signing", "work_order_charge", "late_fee", "nsf_fee",
    ];
    const deposits = new Set(["security_deposit", "holding_deposit"]);
    for (const kind of kinds) {
      const { calls } = await credit(
        [{ id: `hc_${kind}`, kind, amountLabel: "$100.00", cents: 10000 }],
        "resident",
      );
      const component = (calls[0]!.components as { liability_class: string }[])[0]!;
      expect(component.liability_class, kind).toBe(deposits.has(kind) ? "deposit" : "income");
    }
  });

  it("refuses when a settled row's paid cents exceed its own face amount", async () => {
    // The one shape that genuinely cannot be allocated: the components must sum to the
    // frozen subtotal, and a line cannot have been paid more than it ever cost.
    const cart: Cart = [{ id: "hc_rent_1", kind: "rent", amountLabel: "$100.00", cents: 140000 }];
    await expect(credit(cart, "resident")).rejects.toThrow(/exact saved principal/);
  });
});

describe("a credit that lands but cannot pay out", () => {
  const cart: Cart = [{ id: "hc_rent_1", kind: "rent", amountLabel: "$1,400.00", cents: 140000 }];

  it("stands, and files the payout refusal as a release review instead of failing the credit", async () => {
    // The real browser-proof 409: the credit RPC had COMMITTED, then
    // `releaseVerifiedPlatformHoldsForOwner` -> `readyOwnedDestination` threw on a Connect
    // account whose `metadata.axis_user_id` did not match its owner, and the resident was
    // told their settled payment needed review.
    release.throws = new Error("Saved payout account does not match its owner.");
    const { calls } = await credit(cart, "resident");

    expect(calls).toHaveLength(1);
    expect(release.reviews).toEqual([
      {
        stage: "release",
        surface: "hold_release",
        sourceId: SESSION,
        reason: "Saved payout account does not match its owner.",
      },
    ]);
  });

  it("does the same when the recovery settle before it throws", async () => {
    release.settleThrows = new Error("Concurrent platform transfer destination needs retry.");
    await expect(credit(cart, "resident")).resolves.toBeDefined();
    expect(release.reviews.map((r) => r.stage)).toEqual(["release"]);
    // The release never ran, so the hold stays classified_held for the next pass.
    expect(release.calls).toBe(0);
  });

  it("files nothing when the payout goes through", async () => {
    await credit(cart, "resident");
    expect(release.calls).toBe(1);
    expect(release.reviews).toHaveLength(0);
  });

  it("re-runs idempotently on a webhook replay without a second credit of its own", async () => {
    // The credit itself is the RPC, which is idempotent on (source, PI); this asserts the
    // post-credit isolation does not turn a replay into a refusal either.
    release.throws = new Error("Saved payout account does not match its owner.");
    const first = await credit(cart, "resident");
    const second = await credit(cart, "resident");
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(release.reviews).toHaveLength(2);
    expect(new Set(release.reviews.map((r) => r.sourceId))).toEqual(new Set([SESSION]));
  });
});
