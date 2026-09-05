import { beforeEach, describe, expect, it, vi } from "vitest";

const { skuTier, refreshPm } = vi.hoisted(() => ({ skuTier: vi.fn(), refreshPm: vi.fn() }));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: skuTier }));
vi.mock("@/lib/comms-billing/payment-method.server", () => ({
  refreshManagerCommsPaymentMethod: refreshPm,
}));

import {
  evaluateManagerCommsBillingGate,
  commsBillingBlockMessage,
} from "@/lib/comms-billing/eligibility.server";
import {
  COMMS_BILLING_RATES_CENTS,
  COMMS_BILLING_METER_LABELS,
} from "@/lib/comms-billing/rates";

function db(pausedAt: string | null = null, usedCents = 0) {
  const usage = usedCents > 0 ? [{ total_cents: usedCents }] : [];
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { billing_paused_at: pausedAt } }),
          // Month-to-date usage, for the allowance check.
          gte: () => ({ lt: async () => ({ data: usage, error: null }) }),
        }),
      }),
    }),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.COMMS_PAYG_BILLING_ENABLED = "1";
  refreshPm.mockResolvedValue({ hasPaymentMethod: true, checkedAt: "now" });
});

describe("pay-as-you-go is open to every plan", () => {
  it("ALLOWS a free-tier manager who has a card on file", async () => {
    // The whole point of PAYG: cost is billed, not bundled, so the plan does
    // not decide who may text or take calls.
    skuTier.mockResolvedValue({ ok: true, tier: "free" });
    await expect(evaluateManagerCommsBillingGate(db(), "mgr-1")).resolves.toEqual({
      allowed: true,
      billingOwnerId: "mgr-1",
    });
  });

  it("lets anyone send with NO card while inside the included allowance", async () => {
    // The allowance is what makes a work number usable before any billing
    // setup at all — that is the point of it.
    refreshPm.mockResolvedValue({ hasPaymentMethod: false, checkedAt: "now" });
    for (const tier of ["free", "pro"]) {
      skuTier.mockResolvedValue({ ok: true, tier });
      await expect(evaluateManagerCommsBillingGate(db(null, 0), "mgr-1")).resolves.toMatchObject({
        allowed: true,
      });
    }
  });

  it("refuses once the allowance is spent and no card was ever added", async () => {
    refreshPm.mockResolvedValue({ hasPaymentMethod: false, checkedAt: "now" });
    for (const tier of ["free", "pro"]) {
      skuTier.mockResolvedValue({ ok: true, tier });
      await expect(
        evaluateManagerCommsBillingGate(db(null, 1_000_000), "mgr-1"),
      ).resolves.toEqual({ allowed: false, reason: "allowance_exhausted" });
    }
  });

  it("fails CLOSED when the plan cannot be read — we must not bill the wrong account", async () => {
    skuTier.mockResolvedValue({ ok: false });
    await expect(evaluateManagerCommsBillingGate(db(), "mgr-1")).resolves.toEqual({
      allowed: false,
      reason: "plan_unreadable",
    });
  });

  it("respects a paused billing account", async () => {
    skuTier.mockResolvedValue({ ok: true, tier: "free" });
    await expect(evaluateManagerCommsBillingGate(db("2026-09-01T00:00:00Z"), "mgr-1")).resolves.toEqual({
      allowed: false,
      reason: "billing_paused",
    });
  });

  it("is inert when the feature is off, whatever the plan", async () => {
    process.env.COMMS_PAYG_BILLING_ENABLED = "0";
    skuTier.mockResolvedValue({ ok: true, tier: "free" });
    await expect(evaluateManagerCommsBillingGate(db(), "mgr-1")).resolves.toEqual({
      allowed: true,
      billingOwnerId: "mgr-1",
    });
  });

  it("no longer tells a free manager to upgrade — it asks for a card", () => {
    expect(commsBillingBlockMessage("no_payment_method")).toMatch(/including Free/i);
    expect(commsBillingBlockMessage("free_tier")).not.toMatch(/Upgrade to Pro/i);
  });
});

describe("work number setup charge", () => {
  it("is a real one-time meter with a price and a label", () => {
    expect(COMMS_BILLING_RATES_CENTS.work_number_setup).toBeGreaterThan(0);
    expect(COMMS_BILLING_METER_LABELS.work_number_setup).toMatch(/one-time/i);
  });

  it("every priced meter has a label, so no charge shows as a bare key on an invoice", () => {
    for (const meter of Object.keys(COMMS_BILLING_RATES_CENTS)) {
      expect(COMMS_BILLING_METER_LABELS[meter as keyof typeof COMMS_BILLING_METER_LABELS]).toBeTruthy();
    }
  });
});
