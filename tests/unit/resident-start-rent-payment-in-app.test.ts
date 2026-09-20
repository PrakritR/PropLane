/**
 * PLAN-0920-0853 (resident slice): the resident assistant's start_rent_payment
 * tool must point the resident at PropLane's own in-app Payments page, never
 * mint or hand out a hosted checkout.stripe.com session link. Every
 * dependency that would otherwise touch real Stripe/DB state is mocked so
 * this test is a pure check of the tool's own copy and URL construction —
 * `tests/unit/in-app-payment-exits.test.ts` is the source-level guard that
 * this file can never regress without it also failing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({}) as unknown,
}));

vi.mock("@/lib/stripe-connect", () => ({
  resolveAndValidateManagerConnectForPayments: async () => ({ ok: true as const }),
}));

const LOADED_CHARGE = {
  id: "CH-1",
  charge: {
    id: "CH-1",
    title: "Rent — October",
    balanceLabel: "$1,200.00",
    amountLabel: "$1,200.00",
    status: "pending",
  },
  managerUserId: "manager_1",
  propertyFeePayer: null,
  propertyFeeWaiverCode: null,
};

vi.mock("@/lib/stripe-household-charge-checkout.server", () => ({
  MAX_BULK_CHARGES: 20,
  loadHouseholdChargesForCheckout: async () => ({
    ok: true as const,
    managerUserId: "manager_1",
    loaded: [LOADED_CHARGE],
  }),
}));

import { startRentPaymentTool } from "@/lib/tools/domains/resident/payments";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

function makeCtx(): ResidentAgentContext {
  return {
    kind: "resident",
    userId: "resident_a",
    email: "resa@axis.test",
    managerIds: ["manager_1"],
    activeManagerId: "manager_1",
    phase: "approved",
    managerTier: "paid",
    landlordId: "resident_a",
    db: {
      from: () => ({ insert: async () => ({ error: null }) }),
    },
  } as unknown as ResidentAgentContext;
}

describe("start_rent_payment — pays in PropLane, never a hosted checkout link", () => {
  it("preview never mentions Stripe and describes opening Payments in PropLane", async () => {
    const preview = await startRentPaymentTool.preview(makeCtx(), { chargeIds: ["CH-1"] });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toMatch(/stripe/i);
    expect(serialized).toContain("PropLane");
    expect(preview.confirmLabel).toBe("Open Payments");
  });

  it("handler returns the in-app Payments path, never a hosted checkout.stripe.com URL", async () => {
    const result = await startRentPaymentTool.handler(makeCtx(), { chargeIds: ["CH-1"] });
    expect(result.checkoutUrl).toBeTruthy();
    expect(result.checkoutUrl).not.toMatch(/checkout\.stripe\.com/i);
    expect(result.checkoutUrl).not.toMatch(/connect\.stripe\.com/i);
    expect(result.checkoutUrl).toContain("/resident/payments/pending");
    expect(result.reply).toContain("Open Payments to pay in PropLane");
    expect(result.reply).not.toMatch(/stripe/i);
  });
});
