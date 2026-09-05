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

function db(pausedAt: string | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { billing_paused_at: pausedAt } }) }),
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

  it("still refuses anyone without a card, free or paid", async () => {
    refreshPm.mockResolvedValue({ hasPaymentMethod: false, checkedAt: "now" });
    for (const tier of ["free", "pro"]) {
      skuTier.mockResolvedValue({ ok: true, tier });
      await expect(evaluateManagerCommsBillingGate(db(), "mgr-1")).resolves.toEqual({
        allowed: false,
        reason: "no_payment_method",
      });
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
