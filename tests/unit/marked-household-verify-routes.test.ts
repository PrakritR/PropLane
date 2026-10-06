import { beforeEach, describe, expect, it, vi } from "vitest";

const checkoutCredit = vi.hoisted(() => vi.fn(async () => undefined));
const manualCredit = vi.hoisted(() => vi.fn(async () => undefined));
const checkoutPaid = vi.hoisted(() => vi.fn(async () => ({ ok: true, alreadyPaid: false })));
const manualPaid = vi.hoisted(() => vi.fn(async () => ({ ok: true, paid: true,
  processing: false, chargeId: "charge-a" })));
const checkoutAttempt = vi.hoisted(() => vi.fn(async () => ({ charge_ids: ["charge-a"],
  payer_total_cents: 105 })));
const manualAttempt = vi.hoisted(() => vi.fn(async () => ({ charge_ids: ["charge-a"],
  subtotal_cents: 100, payer_total_cents: 105 })));
const session = { id: "cs_exact", status: "complete", payment_status: "paid",
  payment_intent: "pi_exact", metadata: { purpose: "household_charge", source_arbitration_v: "1" } };
const paymentIntent = { id: "pi_exact", status: "succeeded", client_secret: "secret",
  next_action: null };
const stripe = { checkout: { sessions: { retrieve: vi.fn(async () => session) } },
  paymentIntents: { retrieve: vi.fn(async () => paymentIntent) } };
const db = { from: vi.fn(() => ({ select: () => ({ eq: () => ({
  maybeSingle: async () => ({ data: { role: "resident" }, error: null }),
}) }) })) };

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: "resident-a" } } }) },
}) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => true }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));
vi.mock("@/lib/resident-checkout-claim.server", () => ({
  loadResidentCheckoutAttemptForSession: (...args: unknown[]) => checkoutAttempt(...args),
  loadResidentManualAchAttemptForPaymentIntent: (...args: unknown[]) => manualAttempt(...args),
}));
vi.mock("@/lib/stripe-household-charge", () => ({
  isHouseholdChargeCheckoutSession: () => true,
  householdChargeCheckoutProcessing: () => false,
  markHouseholdChargePaidFromStripeSession: (...args: unknown[]) => checkoutPaid(...args),
  reconcileResidentManualAchPaymentIntent: (...args: unknown[]) => manualPaid(...args),
}));
vi.mock("@/lib/household-captured-source.server", () => ({
  creditVerifiedHouseholdCheckoutSource: (...args: unknown[]) => checkoutCredit(...args),
  creditVerifiedHouseholdManualSource: (...args: unknown[]) => manualCredit(...args),
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: async () => undefined,
  TestWorkspaceProviderDisabledError: class extends Error {},
}));

import { GET as verifyCheckout } from "@/app/api/stripe/household-charge-verify/route";
import { GET as verifyManual } from "@/app/api/stripe/resident-ach-payment/route";

describe("marked household verification fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkoutCredit.mockResolvedValue(undefined);
    manualCredit.mockResolvedValue(undefined);
  });

  it("reports a paid Checkout only after exact central source credit, including replay", async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await verifyCheckout(new Request("http://localhost/api/stripe/household-charge-verify?session_id=cs_exact"));
      expect(response.status).toBe(200);
      expect((await response.json()).paid).toBe(true);
    }
    expect(checkoutCredit).toHaveBeenCalledTimes(2);
    expect(checkoutCredit).toHaveBeenCalledWith(db, stripe, session);
  });

  it("returns review after paid Checkout stamp when central source credit fails", async () => {
    checkoutCredit.mockRejectedValueOnce(new Error("source needs review"));
    const response = await verifyCheckout(new Request("http://localhost/api/stripe/household-charge-verify?session_id=cs_exact"));
    expect(response.status).toBe(409);
    expect((await response.json()).paid).toBe(false);
  });

  it("reports manual bank payment paid only after central source credit", async () => {
    const request = () => new Request("http://localhost/api/stripe/resident-ach-payment?payment_intent_id=pi_exact");
    expect((await (await verifyManual(request())).json()).paid).toBe(true);
    manualCredit.mockRejectedValueOnce(new Error("source needs review"));
    const response = await verifyManual(request());
    expect(response.status).toBe(409);
    expect((await response.json()).paid).toBe(false);
    expect(manualCredit).toHaveBeenCalledTimes(2);
    expect(manualCredit).toHaveBeenCalledWith(db, stripe, paymentIntent);
  });
});
