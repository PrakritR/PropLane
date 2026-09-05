import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// This test locks in the money-routing invariant the captain flagged:
// a resident charge for a manager's property must be created on THAT manager's
// OWN Stripe connected account, and a manager who has not onboarded must have
// the charge BLOCKED — never silently routed to the platform account.
//
// `@/lib/stripe-connect` is deliberately NOT mocked: the real resolver reads the
// manager's stored `profiles.stripe_connect_account_id` from the fake DB, so the
// assertion proves the destination is derived per-manager, not hardcoded.

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

vi.mock("@/lib/payment-policy", () => ({
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
 * Fake Supabase client scoped to the three tables the checkout core reads. The
 * `profiles` row is what proves per-manager routing: the resolver reads the
 * connected-account id from here, keyed on the manager's user id.
 */
function makeDb(opts: {
  managerUserId: string;
  managerAccountId: string | null;
  propertyId?: string;
}): SupabaseClient {
  const propertyId = opts.propertyId ?? "prop_1";
  const charge = {
    id: "charge_1",
    kind: "rent",
    status: "due",
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
          data: { id: charge.id, row_data: charge, status: "due", manager_user_id: opts.managerUserId },
          error: null,
        };
      }
      if (table === "manager_property_records") {
        return { data: { property_data: { listingSubmission: { v: 1 } } }, error: null };
      }
      if (table === "profiles") {
        return { data: { stripe_connect_account_id: opts.managerAccountId }, error: null };
      }
      return { data: null, error: null };
    };
    return chain;
  };

  return { from } as unknown as SupabaseClient;
}

const checkoutInput = {
  userId: "res_1",
  userEmail: "resident@example.com",
  chargeIds: ["charge_1"],
  mode: "embedded" as const,
  paymentMethod: "ach" as const,
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

  it("creates the charge on manager A's stored connected account", async () => {
    vi.mocked(getStripe).mockReturnValue(
      makeStripe({ id: "acct_manager_A", capabilities: { transfers: "active" }, payouts_enabled: true }),
    );
    const db = makeDb({ managerUserId: "mgr_A", managerAccountId: "acct_manager_A" });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    expect(createAxisAchCheckoutSession).toHaveBeenCalledTimes(1);
    const passed = createAxisAchCheckoutSession.mock.calls[0]?.[1] as { destinationAccountId?: string };
    expect(passed.destinationAccountId).toBe("acct_manager_A");
  });

  it("routes a different manager's charge to a DIFFERENT account (per-manager isolation)", async () => {
    vi.mocked(getStripe).mockReturnValue(
      makeStripe({ id: "acct_manager_B", capabilities: { transfers: "active" }, payouts_enabled: true }),
    );
    const db = makeDb({ managerUserId: "mgr_B", managerAccountId: "acct_manager_B" });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    const passed = createAxisAchCheckoutSession.mock.calls[0]?.[1] as { destinationAccountId?: string };
    expect(passed.destinationAccountId).toBe("acct_manager_B");
    expect(passed.destinationAccountId).not.toBe("acct_manager_A");
  });

  it("BLOCKS the charge when the manager has not onboarded — no silent platform routing", async () => {
    vi.mocked(getStripe).mockReturnValue(makeStripe({ id: "acct_platform" }));
    const db = makeDb({ managerUserId: "mgr_new", managerAccountId: null });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MANAGER_NO_CONNECT_ACCOUNT");
      expect(result.status).toBe(422);
    }
    // The critical assertion: no checkout session was ever created, so the money
    // cannot have been routed to the platform account as a fallback.
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("BLOCKS the charge when the manager's transfers capability is not active", async () => {
    vi.mocked(getStripe).mockReturnValue(
      makeStripe({ id: "acct_incomplete", capabilities: { transfers: "inactive" }, payouts_enabled: false }),
    );
    const db = makeDb({ managerUserId: "mgr_incomplete", managerAccountId: "acct_incomplete" });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MANAGER_CONNECT_TRANSFERS_NOT_READY");
      expect(result.status).toBe(422);
    }
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });
});
