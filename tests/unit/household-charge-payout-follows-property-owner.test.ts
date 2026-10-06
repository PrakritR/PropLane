import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One property, one bank account.
 *
 * The charge row carries its own `manager_user_id`, stamped by whoever created
 * the charge. Reading the payout destination off that column meant a co-manager
 * who created a charge on an owner's property collected that property's rent
 * into their OWN Stripe account — so a property effectively had as many bank
 * accounts as it had managers. The payee is now the PROPERTY'S owner.
 *
 * Under the central source-arbitration contract the payee is the exact canonical
 * owner carried by the whole-cart claim (`p_manager_user_id`, frozen into the
 * session/PaymentIntent metadata); the capture itself is a platform capture with no
 * Connect destination, and the central source credit allocates it to that owner.
 * A historical charge whose creator differs from the property's actual owner is
 * NOT re-routed to the owner (that would leave its AR/income owner inconsistent):
 * it is refused for review before any claim or provider call. A property with no
 * readable owner fails closed rather than falling back to the row's manager; only a
 * charge filed under no property at all still pays the manager on the row.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));

const createAxisAchCheckoutSession = vi.fn();
vi.mock("@/lib/stripe-axis-ach-checkout", () => ({
  createAxisAchCheckoutSession: (...args: unknown[]) => createAxisAchCheckoutSession(...args),
  stripeNotConfiguredError: (message: string) => message.includes("STRIPE_SECRET_KEY"),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn().mockResolvedValue({ tier: "pro", stripeCustomerId: null }),
}));
vi.mock("@/lib/manager-access", () => ({ normalizeManagerSkuTier: (t: string | null) => t ?? "free" }));
vi.mock("@/lib/household-charge-payment-eligibility", () => ({
  listingFromPropertyData: vi.fn(() => ({ v: 1 })),
  resolveListingForHouseholdCharge: vi.fn().mockResolvedValue({ v: 1 }),
}));
vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  // A charge filed under no property has no listing to read; the manager's own policy answers.
  resolvePropertylessManagerPaymentPolicy: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/payment-policy", async (importOriginal) => ({
  // Real fee math + accepted-method resolution: the claim freezes the real quote.
  ...(await importOriginal<typeof import("@/lib/payment-policy")>()),
  axisPaymentsEnabledOnListing: vi.fn(() => true),
  resolveServiceFeePayer: vi.fn(() => "resident"),
  resolveServiceFeePayerFor: vi.fn(() => "resident"),
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

const OWNER = "mgr_owner";
const CO_MANAGER = "mgr_co";

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


function makeStripe(): Stripe {
  return {
    accounts: {
      retrieve: vi.fn(async (id: string) =>
        ({ id, object: "account", capabilities: { transfers: "active" }, payouts_enabled: true }) as Stripe.Account,
      ),
      update: vi.fn(async (id: string) =>
        ({ id, object: "account", capabilities: { transfers: "active" }, payouts_enabled: true }) as Stripe.Account,
      ),
    },
  } as unknown as Stripe;
}

function makeDb(opts: {
  /** Who the charge row names as its manager — i.e. who created it (row column and row_data). */
  rowManagerUserId: string;
  /** Who actually owns the property, or null for a property with no owner on file. */
  propertyOwnerUserId: string | null;
  connectAccountByUserId: Record<string, string | null>;
  propertyReadFails?: boolean;
  /** A charge filed under no property (a manual one-off). */
  propertyless?: boolean;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const charge = {
    id: "charge_1",
    kind: "rent",
    status: "pending",
    amountCents: 250000,
    residentEmail: "resident@example.com",
    residentUserId: "res_1",
    propertyId: opts.propertyless ? "" : "prop_1",
    managerUserId: opts.rowManagerUserId,
    title: "Rent — March",
    propertyLabel: "123 Main St",
  };

  const from = (table: string) => {
    let pendingId = "";
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (_col: string, value: string) => {
      pendingId = value;
      return chain;
    };
    chain.update = () => chain;
    chain.maybeSingle = async () => {
      if (table === "portal_household_charge_records") {
        return {
          data: { id: charge.id, row_data: charge, status: "pending", manager_user_id: opts.rowManagerUserId },
          error: null,
        };
      }
      if (table === "manager_property_records") {
        if (opts.propertyReadFails) return { data: null, error: { message: "boom" } };
        return {
          data: { property_data: { listingSubmission: { v: 1 } }, manager_user_id: opts.propertyOwnerUserId },
          error: null,
        };
      }
      if (table === "profiles") {
        return {
          data: { stripe_connect_account_id: opts.connectAccountByUserId[pendingId] ?? null },
          error: null,
        };
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
  // Card goes through the shared Checkout builder (a bank payment is a manual PaymentIntent).
  paymentMethod: "card" as const,
  appOrigin: "https://app.test",
};

describe("a property's rent pays the property's OWNER", () => {
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
    vi.mocked(getStripe).mockReturnValue(makeStripe());
  });

  function claimed(rpcCalls: Array<{ name: string; args: Record<string, unknown> }>) {
    return rpcCalls.find((c) => c.name === "reserve_resident_checkout_attempt")?.args;
  }

  it("pays the owner when the owner created the charge on their own property", async () => {
    const { db, rpcCalls } = makeDb({
      rowManagerUserId: OWNER,
      propertyOwnerUserId: OWNER,
      connectAccountByUserId: { [OWNER]: "acct_owner", [CO_MANAGER]: "acct_co_manager" },
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    expect(claimed(rpcCalls)?.p_manager_user_id).toBe(OWNER);
    const passed = createAxisAchCheckoutSession.mock.calls[0]?.[1] as {
      destinationAccountId?: string | null; metadata: Record<string, string>;
    };
    expect(passed.metadata.manager_user_id).toBe(OWNER);
    expect(passed.metadata.manager_user_id).not.toBe(CO_MANAGER);
    // Platform capture: no destination to a co-manager's (or anyone's) connected account.
    expect(passed.destinationAccountId ?? "").toBe("");
  });

  it("refuses a charge the row names a co-manager for (not the owner) before any claim or provider call", async () => {
    const { db, rpcCalls } = makeDb({
      rowManagerUserId: CO_MANAGER,
      propertyOwnerUserId: OWNER,
      connectAccountByUserId: { [OWNER]: "acct_owner", [CO_MANAGER]: "acct_co_manager" },
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.code).toBe("PAYMENT_SOURCE_REVIEW");
    }
    // Neither the co-manager nor (silently) the owner is paid: no claim, no provider call.
    expect(rpcCalls).toEqual([]);
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("fails closed when the property has no owner on file instead of paying the row's manager", async () => {
    const { db, rpcCalls } = makeDb({
      rowManagerUserId: OWNER,
      propertyOwnerUserId: null,
      connectAccountByUserId: { [OWNER]: "acct_owner" },
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("UNRESOLVED_LISTING");
    }
    expect(rpcCalls).toEqual([]);
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("pays the manager named on the row for a charge filed under no property (no owner to prefer)", async () => {
    const { db, rpcCalls } = makeDb({
      rowManagerUserId: OWNER,
      propertyOwnerUserId: null,
      connectAccountByUserId: { [OWNER]: "acct_owner" },
      propertyless: true,
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    expect(claimed(rpcCalls)?.p_manager_user_id).toBe(OWNER);
    const passed = createAxisAchCheckoutSession.mock.calls[0]?.[1] as { metadata: Record<string, string> };
    expect(passed.metadata.manager_user_id).toBe(OWNER);
  });

  it("refuses rather than paying the row's manager when the property cannot be read", async () => {
    const { db, rpcCalls } = makeDb({
      rowManagerUserId: CO_MANAGER,
      propertyOwnerUserId: OWNER,
      connectAccountByUserId: { [CO_MANAGER]: "acct_co_manager" },
      propertyReadFails: true,
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
    expect(rpcCalls).toEqual([]);
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });
});
