import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cartForcesResidentFee,
  isResidentPaysFeeChargeKind,
  residentGrossedUpProcessingFeeCents,
  residentProcessingFeeCents,
  residentServiceFeeBreakdown,
  type ResidentAxisPaymentMethod,
} from "@/lib/payment-policy";

// Captain, 2026-11-12: the processing fee on rent is the RESIDENT's, always, and covers Stripe's whole price.

/** What Stripe takes from a payment of `totalCents`. */
function stripePrice(totalCents: number, method: ResidentAxisPaymentMethod): number {
  return method === "ach" ? Math.min(Math.round(totalCents * 0.008), 500) : Math.round(totalCents * 0.029) + 30;
}

describe("rent kinds always put the processing fee on the resident", () => {
  it("names rent-like kinds, not deposits or application fees", () => {
    for (const kind of ["rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent", "utilities", "stay_total"]) {
      expect(isResidentPaysFeeChargeKind(kind)).toBe(true);
    }
    for (const kind of ["security_deposit", "application_fee", "late_fee", "move_in_fee", "", null, undefined]) {
      expect(isResidentPaysFeeChargeKind(kind)).toBe(false);
    }
  });

  it("one rent line in a cart is enough: a Checkout bills one total", () => {
    expect(cartForcesResidentFee(["security_deposit", "rent"])).toBe(true);
    expect(cartForcesResidentFee(["security_deposit", "move_in_fee"])).toBe(false);
  });
});

describe("a resident-paid fee covers Stripe's price of the whole charge, fee line included", () => {
  it("never leaves PropLane short, for card and bank, across amounts", () => {
    for (const method of ["card", "ach"] as const) {
      for (let subtotal = 100; subtotal <= 500_000; subtotal += 997) {
        const fee = residentGrossedUpProcessingFeeCents(subtotal, method);
        expect(fee).toBeGreaterThanOrEqual(residentProcessingFeeCents(subtotal, method));
        expect(fee).toBeGreaterThanOrEqual(stripePrice(subtotal + fee, method));
        // ...and never by more than a couple of cents: it is a pass-through, not a markup.
        expect(fee - stripePrice(subtotal + fee, method)).toBeLessThanOrEqual(2);
      }
    }
  });

  it("$1,500 of rent by card: 2.9% + $0.30 of the subtotal alone is $1.31 short, so the fee is $45.11", () => {
    expect(residentProcessingFeeCents(150_000, "card")).toBe(4_380);
    expect(residentGrossedUpProcessingFeeCents(150_000, "card")).toBe(4_511);
    const breakdown = residentServiceFeeBreakdown(150_000, "card", "resident", { coverFeeOnFee: true });
    expect(breakdown).toMatchObject({ serviceFeeCents: 4_511, residentAddedFeeCents: 4_511, totalCents: 154_511, managerPayoutCents: 150_000 });
    expect(breakdown.totalCents - breakdown.applicationFeeCents).toBe(breakdown.managerPayoutCents);
  });

  it("a bank debit at the $5.00 cap is unchanged", () => {
    expect(residentGrossedUpProcessingFeeCents(150_000, "ach")).toBe(500);
  });

  it("the option never touches the manager or PropLane payer, and is off unless asked for", () => {
    expect(residentServiceFeeBreakdown(150_000, "card", "manager", { coverFeeOnFee: true }).serviceFeeCents).toBe(4_380);
    expect(residentServiceFeeBreakdown(150_000, "card", "proplane", { coverFeeOnFee: true }).serviceFeeCents).toBe(0);
    expect(residentServiceFeeBreakdown(150_000, "card", "resident").serviceFeeCents).toBe(4_380);
  });
});

const sku = vi.fn();
const manualSettings = vi.fn();
const workspaceSettings = vi.fn();
vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: (...a: unknown[]) => sku(...a) }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: (...a: unknown[]) => manualSettings(...a) }));
vi.mock("@/lib/workspace-payment-settings.server", () => ({ loadWorkspacePaymentSettingsForProperty: (...a: unknown[]) => workspaceSettings(...a) }));
vi.mock("@/lib/payment-policy.server", () => ({
  listingPaymentWaiverCodeMatchesServer: () => true,
  resolveAccountOrListingWaiverGrantedServer: () => true,
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));
vi.mock("@/lib/managed-finance/resolve.server", () => ({ managedCartProblem: async () => null }));
vi.mock("@/lib/managed-finance/unpolicied-service.server", () => ({ serviceSetupPendingProblem: async () => null }));
vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({ resolvePropertylessManagerPaymentPolicy: async () => true }));
vi.mock("@/lib/resident-checkout-claim.server", () => ({}));

import { resolveHouseholdChargeFeePayer } from "@/lib/stripe-household-charge-checkout.server";

describe("resolveHouseholdChargeFeePayer: the one resolver every household payment uses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sku.mockResolvedValue({ tier: "business", promoCode: "ANY", readFailed: false });
    // Everything that could absorb the fee is switched on: staff override, manager choice, workspace choice, listing code.
    manualSettings.mockResolvedValue({ adminServiceFeeOverride: "proplane", serviceFeePayer: "proplane" });
    workspaceSettings.mockResolvedValue({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "X" });
  });

  const row = (kind: string, propertyFeePayer: "manager" | "proplane" | null = "proplane") => ({
    charge: { id: kind, kind, propertyId: "prop_1" } as never,
    propertyFeePayer,
    propertyFeeWaiverCode: "CODE",
  });

  it("rent is the resident's whatever the plan, listing, workspace, code or staff override says", async () => {
    for (const kind of ["rent", "utilities", "first_month_rent", "prorated_rent"]) {
      const result = await resolveHouseholdChargeFeePayer({} as never, "mgr_1", [row(kind)]);
      expect(result).toMatchObject({ ok: true, feePayer: "resident" });
    }
  });

  it("rent stays the resident's even when the plan or settings cannot be read", async () => {
    sku.mockResolvedValue({ tier: null, promoCode: null, readFailed: true });
    manualSettings.mockRejectedValue(new Error("down"));
    const result = await resolveHouseholdChargeFeePayer({} as never, "mgr_1", [row("rent")]);
    expect(result).toMatchObject({ ok: true, feePayer: "resident" });
  });

  it("a cart with any rent line is resident-paid, even beside a deposit on a property that absorbs fees", async () => {
    const result = await resolveHouseholdChargeFeePayer({} as never, "mgr_1", [row("security_deposit"), row("rent")]);
    expect(result).toMatchObject({ ok: true, feePayer: "resident" });
  });

  it("a non-rent charge still follows the settings (deposits are not rent)", async () => {
    const result = await resolveHouseholdChargeFeePayer({} as never, "mgr_1", [row("security_deposit")]);
    expect(result).toMatchObject({ ok: true, feePayer: "proplane" });
  });

  it("a non-rent charge with an unreadable plan still refuses rather than guessing a payer", async () => {
    sku.mockResolvedValue({ tier: null, promoCode: null, readFailed: true });
    const result = await resolveHouseholdChargeFeePayer({} as never, "mgr_1", [row("security_deposit")]);
    expect(result).toMatchObject({ ok: false, status: 500 });
  });
});
