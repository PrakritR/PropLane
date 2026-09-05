import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: vi.fn(),
}));
vi.mock("@/lib/comms-billing/payment-method.server", () => ({
  refreshManagerCommsPaymentMethod: vi.fn(),
}));

import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { refreshManagerCommsPaymentMethod } from "@/lib/comms-billing/payment-method.server";
import { COMMS_BILLING_RATES_CENTS, isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";

const MANAGER = "11111111-1111-1111-1111-111111111111";

function makeDb() {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
  } as never;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getEffectiveManagerSkuTier).mockReset();
  vi.mocked(refreshManagerCommsPaymentMethod).mockReset();
});

describe("comms payg rates", () => {
  it("exposes retail cents for each meter", () => {
    expect(COMMS_BILLING_RATES_CENTS.sms_outbound_segment).toBe(3);
    expect(COMMS_BILLING_RATES_CENTS.ai_agent_turn).toBe(15);
  });
});

describe("evaluateManagerCommsBillingGate", () => {
  it("allows when PAYG is disabled", async () => {
    const res = await evaluateManagerCommsBillingGate(makeDb(), MANAGER);
    expect(res).toEqual({ allowed: true, billingOwnerId: MANAGER });
  });

  it("allows free tier when PAYG is enabled and a card is on file", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
    // Deliberately inverted: pay-as-you-go bills the cost rather than bundling
    // it, so the plan no longer decides who may text or take calls. The card
    // does. See eligibility.server.ts.
    vi.mocked(getEffectiveManagerSkuTier).mockResolvedValue({ ok: true, tier: "free" });
    vi.mocked(refreshManagerCommsPaymentMethod).mockResolvedValue({
      hasPaymentMethod: true,
      checkedAt: new Date().toISOString(),
    });
    const res = await evaluateManagerCommsBillingGate(makeDb(), MANAGER);
    expect(res).toMatchObject({ allowed: true });
  });

  it("blocks paid managers without a payment method", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
    vi.mocked(getEffectiveManagerSkuTier).mockResolvedValue({ ok: true, tier: "pro" });
    vi.mocked(refreshManagerCommsPaymentMethod).mockResolvedValue({
      hasPaymentMethod: false,
      checkedAt: new Date().toISOString(),
    });
    const res = await evaluateManagerCommsBillingGate(makeDb(), MANAGER);
    expect(res).toEqual({ allowed: false, reason: "no_payment_method" });
  });

  it("allows paid managers with a payment method", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
    vi.mocked(getEffectiveManagerSkuTier).mockResolvedValue({ ok: true, tier: "business" });
    vi.mocked(refreshManagerCommsPaymentMethod).mockResolvedValue({
      hasPaymentMethod: true,
      checkedAt: new Date().toISOString(),
    });
    const res = await evaluateManagerCommsBillingGate(makeDb(), MANAGER);
    expect(res).toEqual({ allowed: true, billingOwnerId: MANAGER });
  });
});

describe("recordManagerCommsUsage", () => {
  it("is a no-op insert path when PAYG disabled", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn().mockReturnValue({ insert }),
    } as never;
    const res = await recordManagerCommsUsage(db, {
      managerUserId: MANAGER,
      meter: "sms_outbound_segment",
      quantity: 2,
      idempotencyKey: "sms_outbound:test",
    });
    expect(res.recorded).toBe(true);
    expect(res.totalCents).toBe(6);
    expect(insert).toHaveBeenCalled();
  });
});

describe("isCommsPaygBillingEnabled", () => {
  it("reads env flag", () => {
    expect(isCommsPaygBillingEnabled()).toBe(false);
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
    expect(isCommsPaygBillingEnabled()).toBe(true);
  });
});
