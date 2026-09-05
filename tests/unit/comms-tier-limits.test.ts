/**
 * The phone number is free; what it DOES is limited per plan.
 *
 * Every manager account, Free included, can provision a work number at no
 * charge — a manager cannot evaluate PropLane without one. Messaging, calling
 * and AI are then metered against a per-plan allowance, and a card buys more.
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
    // The regression this pins: at $3/mo the number ate most of Free's
    // allowance, and the number was "free" in name only.
    const free = includedAllowanceCents("free")!;
    expect(COMMS_BILLING_RATES_CENTS.work_number_monthly).toBeLessThan(free / 10);
  });
});

describe("per-tier messaging and calling limits", () => {
  it("gives every tier a real, finite allowance", () => {
    for (const tier of TIERS) {
      const cents = includedAllowanceCents(tier);
      expect(cents, `${tier} must have a limit`).not.toBeNull();
      expect(cents!).toBeGreaterThan(0);
    }
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

  it("buys a usable amount of real work on Free", () => {
    const free = includedAllowanceCents("free")!;
    const texts = Math.floor(free / COMMS_BILLING_RATES_CENTS.sms_outbound_segment);
    expect(texts).toBeGreaterThanOrEqual(50);
  });
});

describe("running out asks for a card rather than an upgrade", () => {
  const usage = (tier: CommsPlanTier, usedCents: number, hasPaymentMethod: boolean) =>
    evaluateCommsAllowance({ tier, usedCents, hasPaymentMethod });

  it("allows everything inside the allowance with no card at all", () => {
    const state = usage("free", includedAllowanceCents("free")! - 1, false);
    expect(state.exhausted).toBe(false);
    expect(state.blocked).toBe(false);
  });

  it("blocks only when the allowance is spent AND there is no card", () => {
    const spent = includedAllowanceCents("free")!;
    expect(usage("free", spent, false).blocked).toBe(true);
    expect(usage("free", spent, true).blocked).toBe(false);
  });

  it("lets a manager pay for more — past the allowance, a card bills", () => {
    const over = includedAllowanceCents("pro")! + 500;
    const state = usage("pro", over, true);
    expect(state.exhausted).toBe(true);
    expect(state.blocked).toBe(false);
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
