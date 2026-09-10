import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  wallet: vi.fn(),
  checkout: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.auth,
}));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  loadCommsWallet: mocks.wallet,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limit }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: mocks.checkout } } }),
}));
import { POST } from "@/app/api/manager/comms-billing/checkout/route";
import {
  fulfillCommsCreditPurchase,
  reverseCommsCreditForCharge,
  createCommsCreditCheckout,
} from "@/lib/comms-billing/credit-purchase.server";
import { COMMS_CREDIT_PURPOSE } from "@/lib/comms-billing/credit-packs";
const id = "12345678-1234-4123-8123-123456789abc";
const request = (body: unknown) =>
  new Request("http://localhost/api/manager/comms-billing/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });
const session = () =>
  ({
    id: "cs_test",
    mode: "payment",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 500,
    amount_total: 500,
    payment_intent: "pi_test",
    client_reference_id: "owner",
    metadata: {
      purpose: COMMS_CREDIT_PURPOSE,
      manager_user_id: "owner",
      purchase_id: id,
      credit_cents: "500",
    },
  }) as Stripe.Checkout.Session;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
  mocks.auth.mockResolvedValue({ userId: "owner", db: {} });
  mocks.wallet.mockResolvedValue({ paused: false });
  mocks.limit.mockResolvedValue({ ok: true });
});
describe("communication credit purchase authorization", () => {
  it("rejects unauthenticated purchases before creating a session", async () => {
    mocks.auth.mockResolvedValue(null);
    expect(
      (await POST(request({ creditCents: 500, purchaseId: id }))).status,
    ).toBe(401);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it.each([
    { creditCents: 1, purchaseId: id },
    { creditCents: 500, purchaseId: id, managerUserId: "victim" },
    { creditCents: 500, purchaseId: "invalid" },
  ])("rejects client price/owner overrides: %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("refuses purchase when credit cannot be verified", async () => {
    mocks.wallet.mockRejectedValue(new Error("offline"));
    expect(
      (await POST(request({ creditCents: 500, purchaseId: id }))).status,
    ).toBe(503);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("does not let a top-up bypass a dispute pause", async () => {
    mocks.wallet.mockResolvedValue({ paused: true });
    expect(
      (await POST(request({ creditCents: 500, purchaseId: id }))).status,
    ).toBe(409);
  });
  it("rechecks the persisted purchase owner before Stripe", async () => {
    const chain = {
      insert: async () => ({ error: { code: "23505" } }),
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: null, error: { code: "PGRST116" } }),
    };
    await expect(
      createCommsCreditCheckout(
        { from: () => chain } as never,
        "attacker",
        id,
        500,
        request({}),
      ),
    ).rejects.toThrow("does not match");
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
});
describe("verified credit fulfillment", () => {
  it("ignores unpaid sessions", async () => {
    const db = { rpc: vi.fn() };
    expect(
      await fulfillCommsCreditPurchase(
        db as never,
        { ...session(), payment_status: "unpaid" },
        "evt",
      ),
    ).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { amount_total: 499 },
    { currency: "eur" },
    { client_reference_id: "victim" },
    { amount_subtotal: 1000 },
    { mode: "subscription" },
    { total_details: { amount_discount: 1 } },
  ])("rejects mismatched paid payment: %j", async (change) => {
    const db = { rpc: vi.fn() };
    await expect(
      fulfillCommsCreditPurchase(
        db as never,
        { ...session(), ...change } as Stripe.Checkout.Session,
        "evt",
      ),
    ).rejects.toThrow("did not match");
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("hands exact verified identity and amount to atomic fulfillment", async () => {
    const db = { rpc: vi.fn(async () => ({ data: true, error: null })) };
    expect(
      await fulfillCommsCreditPurchase(db as never, session(), "evt"),
    ).toBe(true);
    expect(db.rpc).toHaveBeenCalledWith("fulfill_comms_credit_purchase", {
      p_purchase: id,
      p_owner: "owner",
      p_session: "cs_test",
      p_payment_intent: "pi_test",
      p_credit: 500,
      p_event: "evt",
      p_receipt: null,
    });
  });
  it("retries refunds arriving before purchase fulfillment", async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    await expect(
      reverseCommsCreditForCharge(
        { from: () => chain } as never,
        {
          payment_intent: "pi",
          metadata: { purpose: COMMS_CREDIT_PURPOSE },
          amount_refunded: 500,
        } as Stripe.Charge,
        "evt",
      ),
    ).rejects.toThrow("pending");
  });
});
