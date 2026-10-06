import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// This test locks in the money-routing invariant the captain flagged, under the
// central source-arbitration contract (source_arbitration_v=1): a resident
// household charge is captured by the PLATFORM (no Connect destination, no
// provider application fee) from a frozen whole-cart claim, and is attributed to
// the exact canonical owner of the property; the central source credit
// (creditVerifiedHouseholdCheckoutSource) allocates it to THAT manager's own
// funds / hold after the paid capture is verified. So the routing facts proved
// here are: the claim names the right owner per manager (never another), the
// session is created from the frozen platform params whether or not the manager
// has onboarded or has transfers active, and onboarding state is never a reason
// to block or reroute the capture.
//
// `@/lib/stripe-connect` is deliberately NOT mocked: if checkout ever went back to
// resolving a destination, the real resolver would call the Stripe account stub
// below, which these tests assert it never does.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(),
}));

const createAxisAchCheckoutSession = vi.fn();
vi.mock("@/lib/stripe-axis-ach-checkout", () => ({
  createAxisAchCheckoutSession: (...args: unknown[]) => createAxisAchCheckoutSession(...args),
  stripeNotConfiguredError: (message: string) => message.includes("STRIPE_SECRET_KEY"),
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn().mockResolvedValue({ tier: "pro", stripeCustomerId: null }),
}));

vi.mock("@/lib/manager-access", () => ({
  normalizeManagerSkuTier: (t: string | null) => t ?? "free",
}));

vi.mock("@/lib/household-charge-payment-eligibility", () => ({
  listingFromPropertyData: vi.fn(() => ({ v: 1 })),
  resolveListingForHouseholdCharge: vi.fn().mockResolvedValue({ v: 1 }),
}));

vi.mock("@/lib/payment-policy", async (importOriginal) => ({
  // Real fee math + accepted-method resolution: the claim freezes the real quote.
  ...(await importOriginal<typeof import("@/lib/payment-policy")>()),
  axisPaymentsEnabledOnListing: vi.fn(() => true),
  resolveServiceFeePayer: vi.fn(() => "resident"),
  // Production resolves through the precedence-aware form; a double that omits it makes the call
  // undefined and the whole checkout fail for a reason unrelated to what this file tests.
  resolveServiceFeePayerFor: vi.fn(() => "resident"),
  // Same trap, second time (e55113ec added the waiver check): a missing export here
  // throws inside the checkout, which the catch turns into a codeless 500 — so all
  // four money-routing assertions fail without ever reaching the routing logic.
  // No waiver is the neutral case for these tests; the fee split is not what they cover.
  resolveAccountOrListingWaiverGranted: vi.fn(() => false),
}));

vi.mock("@/lib/manager-manual-payment-settings", () => ({
  loadManagerManualPaymentSettings: vi.fn().mockResolvedValue({ serviceFeePayer: "resident" }),
}));
vi.mock("@/lib/payment-policy.server", () => ({
  listingPaymentWaiverCodeMatchesServer: vi.fn(() => false),
  resolveAccountOrListingWaiverGrantedServer: vi.fn(() => false),
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));
vi.mock("@/lib/proplane-balance/flag", () => ({
  proplaneBalanceEnabled: vi.fn(() => false),
}));

vi.mock("@/lib/stripe-household-charge", () => ({
  householdChargeAmountCents: (charge: { amountCents?: number }) => charge.amountCents ?? 250000,
  HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE: "household_charge",
}));

import { getStripe } from "@/lib/stripe";
import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";

/** Minimal Stripe stub — only the Connect account calls the real resolver makes. */
function makeStripe(account: Partial<Stripe.Account>): Stripe {
  const acct = { id: account.id ?? "acct_unset", object: "account", ...account } as Stripe.Account;
  return {
    accounts: {
      retrieve: vi.fn().mockResolvedValue(acct),
      update: vi.fn().mockResolvedValue(acct),
    },
  } as unknown as Stripe;
}


/**
 * Models the whole-cart claim RPCs. `reserve_resident_checkout_attempt` freezes the
 * request it is handed (what the SQL does for a fresh cart); `bind_resident_checkout_session`
 * stamps the provider id. Calls are recorded so a test can prove what was claimed, and in
 * what order relative to the provider call.
 */
function claimRpc(rpcCalls: Array<{ name: string; args: Record<string, unknown> }>) {
  return async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "reserve_resident_checkout_attempt") {
      return {
        data: {
          id: "attempt_1",
          attempt_token: args.p_attempt_token,
          resident_user_id: args.p_resident_user_id,
          resident_email: args.p_resident_email,
          manager_user_id: args.p_manager_user_id,
          charge_ids: args.p_charge_ids,
          charge_cents: args.p_charge_cents,
          subtotal_cents: args.p_subtotal_cents,
          payer_total_cents: args.p_payer_total_cents,
          recipient_net_cents: args.p_recipient_net_cents,
          payment_method: args.p_payment_method,
          currency: "usd",
          provider_params: args.p_provider_params,
          stripe_session_id: null,
          stripe_payment_intent_id: null,
          status: "pending",
          created_at: new Date().toISOString(),
        },
        error: null,
      };
    }
    if (name === "bind_resident_checkout_session") return { data: true, error: null };
    return { data: null, error: null };
  };
}

/**
 * Fake Supabase client scoped to the tables the checkout core reads. The property row
 * names the canonical owner; the charge row is stamped with that same manager (a charge
 * created under anyone else is refused before any claim, see the owner test file).
 * `profiles` still carries each manager's connected-account id so a regression that
 * resolved a destination from it would be visible to the Stripe stub.
 */
function makeDb(opts: {
  managerUserId: string;
  managerAccountId: string | null;
  propertyId?: string;
}) {
  const propertyId = opts.propertyId ?? "prop_1";
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const charge = {
    id: "charge_1",
    kind: "rent",
    status: "pending",
    amountCents: 250000,
    residentEmail: "resident@example.com",
    residentUserId: "res_1",
    propertyId,
    managerUserId: opts.managerUserId,
    title: "Rent — March",
    propertyLabel: "123 Main St",
  };

  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.update = () => chain;
    chain.maybeSingle = async () => {
      if (table === "portal_household_charge_records") {
        return {
          data: { id: charge.id, row_data: charge, status: "pending", manager_user_id: opts.managerUserId },
          error: null,
        };
      }
      if (table === "manager_property_records") {
        return {
          data: { property_data: { listingSubmission: { v: 1 } }, manager_user_id: opts.managerUserId },
          error: null,
        };
      }
      if (table === "profiles") {
        return { data: { stripe_connect_account_id: opts.managerAccountId }, error: null };
      }
      return { data: null, error: null };
    };
    return chain;
  };

  return { db: { from, rpc: claimRpc(rpcCalls) } as unknown as SupabaseClient, rpcCalls };
}

const checkoutInput = {
  userId: "res_1",
  userEmail: "resident@example.com",
  chargeIds: ["charge_1"],
  mode: "embedded" as const,
  // Card goes through the shared Checkout builder; bank (ACH) is a manual PaymentIntent.
  paymentMethod: "card" as const,
  appOrigin: "https://app.test",
};

describe("resident charge routes to the manager's OWN connected account", () => {
  beforeEach(() => {
    createAxisAchCheckoutSession.mockReset();
    createAxisAchCheckoutSession.mockResolvedValue({
      mode: "embedded",
      clientSecret: "cs_secret",
      sessionId: "cs_session",
      subtotalCents: 250000,
      processingFeeCents: 0,
      axisFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 250000,
      paymentMethod: "ach",
    });
  });

  /** The claim reserved for this cart, and the frozen params the provider was handed. */
  function claimed(rpcCalls: Array<{ name: string; args: Record<string, unknown> }>) {
    return rpcCalls.find((c) => c.name === "reserve_resident_checkout_attempt")!.args;
  }
  function providerParams() {
    return createAxisAchCheckoutSession.mock.calls[0]?.[1] as {
      destinationAccountId?: string | null;
      fundingModel?: string;
      metadata: Record<string, string>;
    };
  }

  it("captures manager A's charge on the platform and claims it for manager A's own account", async () => {
    const stripe = makeStripe({ id: "acct_manager_A", capabilities: { transfers: "active" }, payouts_enabled: true });
    vi.mocked(getStripe).mockReturnValue(stripe);
    const { db, rpcCalls } = makeDb({ managerUserId: "mgr_A", managerAccountId: "acct_manager_A" });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    expect(createAxisAchCheckoutSession).toHaveBeenCalledTimes(1);
    // The claim names the property owner as the payee (claim-before-provider ordering is proven in ach-checkout.test.ts).
    expect(claimed(rpcCalls)).toMatchObject({ p_manager_user_id: "mgr_A", p_charge_ids: ["charge_1"] });
    const passed = providerParams();
    expect(passed.metadata.manager_user_id).toBe("mgr_A");
    // Central capture: no Connect destination, even though A is fully onboarded.
    expect(passed.destinationAccountId ?? "").toBe("");
    expect(passed.fundingModel).toBe("connect_destination");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("claims a different manager's charge for a DIFFERENT owner (per-manager isolation)", async () => {
    vi.mocked(getStripe).mockReturnValue(
      makeStripe({ id: "acct_manager_B", capabilities: { transfers: "active" }, payouts_enabled: true }),
    );
    const { db, rpcCalls } = makeDb({ managerUserId: "mgr_B", managerAccountId: "acct_manager_B" });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    expect(claimed(rpcCalls).p_manager_user_id).toBe("mgr_B");
    expect(claimed(rpcCalls).p_manager_user_id).not.toBe("mgr_A");
    const passed = providerParams();
    expect(passed.metadata.manager_user_id).toBe("mgr_B");
    expect(passed.metadata.manager_user_id).not.toBe("mgr_A");
    expect(passed.destinationAccountId ?? "").toBe("");
  });

  it("still captures on the platform (hold) when the manager has not onboarded", async () => {
    const stripe = makeStripe({ id: "acct_platform" });
    vi.mocked(getStripe).mockReturnValue(stripe);
    const { db, rpcCalls } = makeDb({ managerUserId: "mgr_new", managerAccountId: null });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    // Never a 422 for missing Connect and never a reroute: the claim is for mgr_new and the money is held for them.
    expect(result.ok).toBe(true);
    expect(claimed(rpcCalls).p_manager_user_id).toBe("mgr_new");
    expect(providerParams().destinationAccountId ?? "").toBe("");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("still captures on the platform (hold) when the manager's transfers capability is not active", async () => {
    const stripe = makeStripe({ id: "acct_incomplete", capabilities: { transfers: "inactive" }, payouts_enabled: false });
    vi.mocked(getStripe).mockReturnValue(stripe);
    const { db, rpcCalls } = makeDb({ managerUserId: "mgr_incomplete", managerAccountId: "acct_incomplete" });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    expect(claimed(rpcCalls).p_manager_user_id).toBe("mgr_incomplete");
    expect(providerParams().destinationAccountId ?? "").toBe("");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("creates a bank (ACH) PaymentIntent with no transfer destination for an onboarded manager too", async () => {
    const stripe = makeStripe({ id: "acct_manager_A", capabilities: { transfers: "active" }, payouts_enabled: true });
    const create = vi.fn(async (params: Record<string, unknown>) => ({
      id: "pi_manual", ...params, status: "requires_payment_method", client_secret: "pi_manual_secret",
    }));
    (stripe as unknown as { paymentIntents: unknown }).paymentIntents = { create };
    vi.mocked(getStripe).mockReturnValue(stripe);
    const { db, rpcCalls } = makeDb({ managerUserId: "mgr_A", managerAccountId: "acct_manager_A" });

    const result = await createHouseholdChargeCheckout(db, { ...checkoutInput, paymentMethod: "ach" as never });

    expect(result.ok).toBe(true);
    expect(claimed(rpcCalls)).toMatchObject({ p_manager_user_id: "mgr_A", p_payment_method: "ach" });
    const [piParams] = create.mock.calls[0]!;
    expect(piParams).not.toHaveProperty("transfer_data");
    expect(piParams).not.toHaveProperty("application_fee_amount");
    expect(piParams).toMatchObject({ metadata: { manager_user_id: "mgr_A", platform_hold: "1" } });
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });
});
