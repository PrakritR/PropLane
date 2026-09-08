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
 */

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
vi.mock("@/lib/payment-policy", () => ({
  axisPaymentsEnabledOnListing: vi.fn(() => true),
  resolveServiceFeePayer: vi.fn(() => "resident"),
  resolveServiceFeePayerFor: vi.fn(() => "resident"),
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

const OWNER = "mgr_owner";
const CO_MANAGER = "mgr_co";

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
  /** Who the charge row names as its manager — i.e. who created it. */
  rowManagerUserId: string;
  /** Who actually owns the property, or null for a property with no owner on file. */
  propertyOwnerUserId: string | null;
  connectAccountByUserId: Record<string, string | null>;
  propertyReadFails?: boolean;
}): SupabaseClient {
  const charge = {
    id: "charge_1",
    kind: "rent",
    status: "due",
    amountCents: 250000,
    residentEmail: "resident@example.com",
    residentUserId: "res_1",
    propertyId: "prop_1",
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
          data: { id: charge.id, row_data: charge, status: "due", manager_user_id: opts.rowManagerUserId },
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

  it("pays the owner even when the charge row names a co-manager", async () => {
    const db = makeDb({
      rowManagerUserId: CO_MANAGER,
      propertyOwnerUserId: OWNER,
      connectAccountByUserId: { [OWNER]: "acct_owner", [CO_MANAGER]: "acct_co_manager" },
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    const passed = createAxisAchCheckoutSession.mock.calls[0]?.[1] as { destinationAccountId?: string };
    expect(passed.destinationAccountId).toBe("acct_owner");
    expect(passed.destinationAccountId).not.toBe("acct_co_manager");
  });

  it("pays the manager named on the row when the property has no owner on file", async () => {
    const db = makeDb({
      rowManagerUserId: OWNER,
      propertyOwnerUserId: null,
      connectAccountByUserId: { [OWNER]: "acct_owner" },
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(true);
    const passed = createAxisAchCheckoutSession.mock.calls[0]?.[1] as { destinationAccountId?: string };
    expect(passed.destinationAccountId).toBe("acct_owner");
  });

  it("refuses rather than paying the row's manager when the property cannot be read", async () => {
    const db = makeDb({
      rowManagerUserId: CO_MANAGER,
      propertyOwnerUserId: OWNER,
      connectAccountByUserId: { [CO_MANAGER]: "acct_co_manager" },
      propertyReadFails: true,
    });

    const result = await createHouseholdChargeCheckout(db, checkoutInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });
});
