import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findHold: vi.fn(), verifySource: vi.fn() }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  findPlatformHoldByPaymentIntent: mocks.findHold,
}));
vi.mock("@/lib/platform-hold-release.server", () => ({
  verifyPlatformHoldSourceRefundHistory: mocks.verifySource,
}));

import { creditVerifiedVendorCheckoutSource, verifyLegacyVendorCheckoutSource } from "@/lib/vendor-captured-source.server";

const terms = { purpose: "vendor_invoice_direct_pay", managerUserId: "manager-1",
  vendorUserId: "vendor-1", sourceId: "direct:invoice-1",
  componentId: "invoice-1", componentKind: "vendor_invoice" as const,
  principalCents: 10000, platformFeeCents: 300 };
const metadata = { source_arbitration_v: "1", purpose: terms.purpose,
  manager_user_id: terms.managerUserId, vendor_user_id: terms.vendorUserId,
  invoice_cents: "10000", platform_fee_cents: "300",
  platform_hold: "1", hold_amount_cents: "9700", fee_payer: "resident",
  processing_fee_cents: "332" };
const session = { id: "cs_vendor", status: "complete", payment_status: "paid",
  currency: "usd", amount_total: 10332, payment_intent: "pi_vendor", metadata };
const pi = { id: "pi_vendor", status: "succeeded", currency: "usd",
  amount_received: 10332, latest_charge: "ch_vendor", metadata };
const charge = { id: "ch_vendor", payment_intent: "pi_vendor", paid: true,
  status: "succeeded", currency: "usd", amount: 10332,
  amount_refunded: 0, disputed: false, refunded: false };

function fixture() {
  const rpc = vi.fn(async () => ({ data: [{ hold_id: "hold-vendor", credited: true }], error: null }));
  const db = { rpc };
  const stripe = {
    paymentIntents: { retrieve: vi.fn(async () => pi) },
    charges: { retrieve: vi.fn(async () => charge) },
    refunds: { list: vi.fn(async () => ({ data: [], has_more: false })) },
  };
  return { db, stripe, rpc };
}

describe("verified vendor Checkout source", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findHold.mockResolvedValue(null); });

  it("credits only the frozen vendor net from its exact central PI and Charge", async () => {
    const f = fixture();
    expect(await creditVerifiedVendorCheckoutSource(f.db as never, f.stripe as never,
      session as never, terms)).toEqual({ holdId: "hold-vendor", chargeId: "ch_vendor",
        recipientNetCents: 9700 });
    expect(f.rpc).toHaveBeenCalledWith("credit_verified_platform_hold",
      expect.objectContaining({ p_owner: "vendor-1", p_owner_role: "vendor",
        p_source_id: "direct:invoice-1", p_charge_gross: 10332,
        p_principal: 10000, p_original_net: 9700, p_fee_payer: "manager",
        p_components: [{ source_id: "invoice-1", kind: "vendor_invoice",
          liability_class: "vendor", principal_cents: 10000,
          recipient_net_cents: 9700 }] }));
  });

  it("rejects a foreign destination and a provider refund before any credit", async () => {
    const f = fixture();
    f.stripe.paymentIntents.retrieve.mockResolvedValueOnce({ ...pi,
      transfer_data: { destination: "acct_other" } } as never);
    await expect(creditVerifiedVendorCheckoutSource(f.db as never, f.stripe as never,
      session as never, terms)).rejects.toThrow(/PaymentIntent differs/);
    f.stripe.refunds.list.mockResolvedValueOnce({ data: [{ id: "re_unknown" }],
      has_more: false } as never);
    await expect(creditVerifiedVendorCheckoutSource(f.db as never, f.stripe as never,
      session as never, terms)).rejects.toThrow(/allocation reconciliation/);
    expect(f.rpc).not.toHaveBeenCalled();
  });
});

describe("historical vendor hold preflight", () => {
  const legacyMeta = { ...metadata, source_arbitration_v: undefined };
  const legacySession = { ...session, metadata: legacyMeta };
  const legacyPi = { ...pi, metadata: { ...legacyMeta, source_arbitration_v: undefined } };
  const legacyTerms = { purpose: terms.purpose, managerUserId: terms.managerUserId,
    vendorUserId: terms.vendorUserId, principalCents: 10000,
    platformFeeCents: 300, sourceId: terms.sourceId };
  const db = { from: () => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  } };

  it("attests the original central charge before old-path settlement", async () => {
    const f = fixture();
    f.stripe.paymentIntents.retrieve.mockResolvedValue(legacyPi as never);
    expect(await verifyLegacyVendorCheckoutSource(db as never, f.stripe as never,
      legacySession as never, legacyTerms)).toEqual({ chargeId: "ch_vendor" });
  });

  it("stops an already-refunded legacy charge before paid mutation", async () => {
    const f = fixture();
    f.stripe.paymentIntents.retrieve.mockResolvedValue(legacyPi as never);
    f.stripe.refunds.list.mockResolvedValue({ data: [{ id: "re_unknown" }], has_more: false } as never);
    await expect(verifyLegacyVendorCheckoutSource(db as never, f.stripe as never,
      legacySession as never, legacyTerms)).rejects.toThrow(/refund history/);
  });
});
