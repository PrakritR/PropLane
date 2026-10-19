/**
 * The one branch the hardened hold rail takes for a PropLane-managed workspace: the verified capture is allocated in the party
 * ledger (owner / fee / deposit) and NEVER credited to a manager hold, never released to a manager's account. Every other
 * workspace takes the unchanged hold path. Built on the same Checkout shapes as household-captured-source-credit-shapes.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { residentServiceFeeBreakdown } from "@/lib/payment-policy";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe-ledger-fees", () => ({ enrichLedgerPaymentFromStripeCharge: vi.fn(async () => undefined) }));
const state = vi.hoisted(() => ({ releases: 0, hold: null as null | { id: string }, managed: null as unknown, managedError: null as Error | null, captured: [] as unknown[] }));
vi.mock("@/lib/platform-hold-release.server", () => ({
  verifyPlatformHoldSourceRefundHistory: vi.fn(async () => undefined),
  releaseVerifiedPlatformHoldsForOwner: vi.fn(async () => { state.releases += 1; }),
}));
vi.mock("@/lib/platform-owner-recovery.server", () => ({
  settleClearedPlatformOwnerRecovery: vi.fn(async () => undefined),
  verifiedCapturedChargeAvailability: vi.fn(async () => ({ availableOn: null })),
}));
vi.mock("@/lib/household-source-review.server", () => ({ recordHouseholdSourceReviewNeeded: vi.fn(async () => ({ recorded: true, reason: "" })) }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  findPlatformHold: vi.fn(async () => null),
  findPlatformHoldByPaymentIntent: vi.fn(async () => state.hold),
}));
vi.mock("@/lib/managed-finance/resolve.server", () => ({
  resolveManagedForProperties: vi.fn(async () => { if (state.managedError) throw state.managedError; return state.managed; }),
}));
vi.mock("@/lib/managed-finance/capture.server", () => ({
  creditManagedCapture: vi.fn(async (_db: unknown, _stripe: unknown, input: unknown) => { state.captured.push(input); return { status: "created", journalId: "j1" }; }),
}));

const { creditVerifiedHouseholdCheckoutSource } = await import("@/lib/household-captured-source.server");

const MANAGER = "11111111-1111-4111-8111-111111111111";
const SESSION = "cs_test_managed";
const PI = "pi_test_managed";
const CH = "ch_test_managed";
const POLICY = { id: "pol", workspaceId: "ws", ownerUserId: "own", status: "active", signedAt: "x", terms: {} };

type Cart = { id: string; kind: string; label: string; cents: number }[];

function objects(cart: Cart, feePayer: "resident" | "manager") {
  const subtotal = cart.reduce((s, c) => s + c.cents, 0);
  const fee = residentServiceFeeBreakdown(subtotal, "card", feePayer);
  const metadata: Record<string, string> = {
    purpose: "household_charge", source_arbitration_v: "1", charge_id: cart[0]!.id, charge_ids: cart.map((c) => c.id).join(","),
    manager_user_id: MANAGER, resident_email: "r@x.test", property_id: "prop-1", bulk: "false", resident_attempt_token: "t",
    payment_method: "card", manager_tier: "paid", fee_payer: feePayer, subtotal_cents: String(subtotal),
    processing_fee_cents: String(fee.residentAddedFeeCents), axis_fee_cents: "0", service_fee_cents: String(fee.serviceFeeCents),
    manager_payout_cents: String(fee.managerPayoutCents), platform_hold: "1", hold_amount_cents: String(fee.managerPayoutCents),
  };
  const gross = subtotal + fee.residentAddedFeeCents;
  return {
    session: { id: SESSION, mode: "payment", status: "complete", payment_status: "paid", currency: "usd", amount_total: gross, payment_intent: PI, metadata },
    pi: { id: PI, status: "succeeded", currency: "usd", amount: gross, amount_received: gross, latest_charge: CH, metadata },
    charge: { id: CH, payment_intent: PI, paid: true, captured: true, status: "succeeded", currency: "usd", amount: gross, amount_refunded: 0, disputed: false, refunded: false },
    gross, subtotal, fee,
  };
}

function dbFor(cart: Cart) {
  const rows = cart.map((c) => ({
    id: c.id, manager_user_id: MANAGER, kind: c.kind, status: "paid",
    row_data: { id: c.id, managerUserId: MANAGER, residentEmail: "r@x.test", propertyId: "prop-1", kind: c.kind, title: "Rent", amountLabel: c.label, balanceLabel: "$0.00", status: "paid", paidAmountCents: c.cents, paidAt: "2026-10-17T00:00:00.000Z", stripeCheckoutSessionId: SESSION, stripePaymentStatus: "paid", blocksLeaseUntilPaid: false },
  }));
  const rpcs: string[] = [];
  return {
    rpcs,
    db: {
      from() {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "limit"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: null, error: null });
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
        return q;
      },
      async rpc(name: string) { rpcs.push(name); return { data: [{ hold_id: "hold-1" }], error: null }; },
    },
  };
}

async function run(cart: Cart, feePayer: "resident" | "manager" = "resident") {
  const o = objects(cart, feePayer);
  const { db, rpcs } = dbFor(cart);
  const stripe = { paymentIntents: { retrieve: async () => o.pi }, charges: { retrieve: async () => o.charge }, refunds: { list: async () => ({ data: [], has_more: false }) } };
  await creditVerifiedHouseholdCheckoutSource(db as never, stripe as never, o.session as never);
  return { rpcs, ...o };
}

beforeEach(() => { state.releases = 0; state.hold = null; state.managed = null; state.managedError = null; state.captured = []; });

describe("a managed workspace's capture", () => {
  const rent: Cart = [{ id: "hc_rent", kind: "rent", label: "$1,000.00", cents: 100000 }];
  it("is allocated in the party ledger and never credited to a hold or released", async () => {
    state.managed = { workspaceId: "ws", policy: POLICY };
    const { rpcs, gross } = await run(rent);
    expect(rpcs).toEqual([]);
    expect(state.releases).toBe(0);
    expect(state.captured).toHaveLength(1);
    expect(state.captured[0]).toMatchObject({
      policy: POLICY, paymentIntentId: PI, stripeChargeId: CH, grossCents: gross,
      components: [{ id: "hc_rent", kind: "rent", liabilityClass: "income", principalCents: 100000, recipientNetCents: 100000, propertyId: "prop-1" }],
    });
  });
  it("passes the frozen per-charge nets (a manager-borne fee comes off the distributable amount) and keeps deposits separate", async () => {
    state.managed = { workspaceId: "ws", policy: POLICY };
    const cart: Cart = [
      { id: "hc_dep", kind: "security_deposit", label: "$500.00", cents: 50000 },
      { id: "hc_rent", kind: "rent", label: "$1,000.00", cents: 100000 },
    ];
    const { fee, subtotal } = await run(cart, "manager");
    const input = state.captured[0] as { components: Array<{ id: string; liabilityClass: string; principalCents: number; recipientNetCents: number }> };
    expect(input.components.find((c) => c.id === "hc_dep")!.liabilityClass).toBe("deposit");
    expect(input.components.reduce((s, c) => s + c.principalCents, 0)).toBe(subtotal);
    expect(input.components.reduce((s, c) => s + c.recipientNetCents, 0)).toBe(fee.managerPayoutCents);
  });
  it("a workspace that is not managed takes the unchanged hold path", async () => {
    state.managed = null;
    const { rpcs } = await run(rent);
    expect(state.captured).toHaveLength(0);
    expect(rpcs).toContain("credit_platform_income_with_recovery");
    expect(state.releases).toBe(1);
  });
  it("a payment that was already credited as a hold stays a hold (a policy created afterwards does not re-allocate it)", async () => {
    state.managed = { workspaceId: "ws", policy: POLICY };
    state.hold = { id: "hold-1" };
    // The existing hold's own verification runs (the harness has no verified hold row, so it refuses): the point is that the
    // managed allocation was NOT taken and the hold path was.
    await expect(run(rent)).rejects.toThrow(/unverified prior allocation/);
    expect(state.captured).toHaveLength(0);
  });
  it("a lookup that fails throws: it never falls through to a manager hold", async () => {
    state.managedError = new Error("Could not confirm which workspace this payment belongs to.");
    const o = objects(rent, "resident");
    const { db, rpcs } = dbFor(rent);
    const stripe = { paymentIntents: { retrieve: async () => o.pi }, charges: { retrieve: async () => o.charge }, refunds: { list: async () => ({ data: [], has_more: false }) } };
    await expect(creditVerifiedHouseholdCheckoutSource(db as never, stripe as never, o.session as never)).rejects.toThrow(/Could not confirm/);
    expect(rpcs).toEqual([]);
    expect(state.releases).toBe(0);
  });
});
