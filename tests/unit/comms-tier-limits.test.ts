/**
 * The phone number carries no rental charge; what it DOES is limited per plan.
 *
 * Round 3 plan model: Free has no work number and no credit. Pro and Business
 * include a number; messaging, calling and AI are then metered against a
 * per-plan allowance, and a pack buys more.
 */
import { describe, expect, it } from "vitest";
import {
  COMMS_INCLUDED_ALLOWANCE_CENTS,
  billableCentsAboveAllowance,
  evaluateCommsAllowance,
  includedAllowanceCents,
  normalizeCommsPlanTier,
  type CommsPlanTier,
} from "@/lib/comms-billing/allowances";
import { COMMS_BILLING_RATES_CENTS, COMMS_BILLING_METER_LABELS } from "@/lib/comms-billing/rates";

const TIERS: CommsPlanTier[] = ["free", "pro", "business"];

describe("the work number itself is free on every plan", () => {
  it("charges nothing to provision or to hold", () => {
    expect(COMMS_BILLING_RATES_CENTS.work_number_setup).toBe(0);
    expect(COMMS_BILLING_RATES_CENTS.work_number_monthly).toBe(0);
  });

  it("keeps both meters declared, so the ledger still records the number", () => {
    expect(COMMS_BILLING_METER_LABELS.work_number_setup).toBeTruthy();
    expect(COMMS_BILLING_METER_LABELS.work_number_monthly).toBeTruthy();
  });

  it("so the number never consumes a manager's messaging allowance", () => {
    // The regression this pins: at $3/mo the number ate most of the smallest
    // paid allowance, and the number was "included" in name only.
    const pro = includedAllowanceCents("pro")!;
    expect(COMMS_BILLING_RATES_CENTS.work_number_monthly).toBeLessThan(pro / 10);
  });
});

describe("per-tier messaging and calling limits", () => {
  it("gives every tier a finite allowance; only the paid ones are above zero", () => {
    for (const tier of TIERS) {
      const cents = includedAllowanceCents(tier);
      expect(cents, `${tier} must have a limit`).not.toBeNull();
    }
    expect(includedAllowanceCents("free")).toBe(0);
    expect(includedAllowanceCents("pro")!).toBeGreaterThan(0);
    expect(includedAllowanceCents("business")!).toBeGreaterThan(0);
  });

  it("scales strictly with price — Free < Pro < Business", () => {
    expect(COMMS_INCLUDED_ALLOWANCE_CENTS.free!).toBeLessThan(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!);
    expect(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!).toBeLessThan(COMMS_INCLUDED_ALLOWANCE_CENTS.business!);
  });

  it("stays well inside each plan's price", () => {
    // Retail allowance costs us roughly a third of its face value at the
    // modelled rates, so this is a generous margin check, not a tight one.
    const monthlyPriceCents = { free: 0, pro: 2000, business: 20000 } as const;
    for (const tier of ["pro", "business"] as const) {
      const atCost = includedAllowanceCents(tier)! / 3;
      expect(atCost, `${tier} allowance must not exceed its plan price`).toBeLessThan(
        monthlyPriceCents[tier],
      );
    }
  });

  it("buys a usable amount of real work on Pro", () => {
    const pro = includedAllowanceCents("pro")!;
    const texts = Math.floor(pro / COMMS_BILLING_RATES_CENTS.sms_outbound_segment);
    expect(texts).toBeGreaterThanOrEqual(50);
  });
});

describe("running out requires purchased credit", () => {
  const usage = (tier: CommsPlanTier, usedCents: number, hasPaymentMethod: boolean) =>
    evaluateCommsAllowance({ tier, usedCents, hasPaymentMethod });

  it("allows everything inside the allowance with no card at all", () => {
    const state = usage("pro", includedAllowanceCents("pro")! - 1, false);
    expect(state.exhausted).toBe(false);
    expect(state.blocked).toBe(false);
  });

  it("blocks when allowance is spent even with a card", () => {
    const spent = includedAllowanceCents("pro")!;
    expect(usage("pro", spent, false).blocked).toBe(true);
    expect(usage("pro", spent, true).blocked).toBe(true);
    // Free starts spent: no included credit at all.
    expect(usage("free", 0, true).blocked).toBe(true);
  });

  it("a saved card does not enable automatic usage charges", () => {
    const over = includedAllowanceCents("pro")! + 500;
    const state = usage("pro", over, true);
    expect(state.exhausted).toBe(true);
    expect(state.blocked).toBe(true);
    expect(billableCentsAboveAllowance({ tier: "pro", totalUsedCents: over })).toBe(500);
  });

  it("bills Business above its cap too, rather than being unmetered", () => {
    const over = includedAllowanceCents("business")! + 1000;
    expect(billableCentsAboveAllowance({ tier: "business", totalUsedCents: over })).toBe(1000);
  });

  it("reads an unknown plan as the most restrictive one", () => {
    expect(normalizeCommsPlanTier(null)).toBe("free");
    expect(normalizeCommsPlanTier("platinum")).toBe("free");
    expect(normalizeCommsPlanTier("  Business ")).toBe("business");
  });
});
