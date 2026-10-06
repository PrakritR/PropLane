import { describe, expect, it } from "vitest";
import { applicationPaymentReceipt } from "@/lib/application-payment-receipt";

const claim = {
  application_id: "application-b", manager_user_id: "manager-1", property_id: "property-1",
  resident_email: "resident@example.test", charge_id: "charge-b", status: "settled",
  promotion_status: "complete", stripe_session_id: "cs_test_b", principal_cents: 5000, payer_total_cents: 5044,
};
const charge = { id: "charge-b", status: "paid", row_data: {
  applicationId: "application-b", amountLabel: "$50.00", paidAt: "2026-10-04T12:00:00Z",
  stripeCheckoutSessionId: "cs_test_b",
} };
const payment = { manager_user_id: "manager-1", amount_cents: 5000, stripe_checkout_session_id: "cs_test_b" };
const base = {
  applicationId: "application-b", managerUserId: "manager-1", propertyId: "property-1",
  residentEmail: "resident@example.test", claim, exactCharges: [charge], ambiguousLegacyCharges: [],
  payments: [payment], refunds: [],
};

describe("exact application receipt", () => {
  it("uses captured principal and original paid date, even if a listing changes", () => {
    expect(applicationPaymentReceipt(base)).toEqual({ status: "paid", principalCents: 5000, paidAt: charge.row_data.paidAt });
  });

  it("shows processing and absent sources distinctly", () => {
    expect(applicationPaymentReceipt({ ...base, claim: { ...claim, status: "pending" },
      exactCharges: [{ ...charge, status: "processing" }], payments: [] }).status).toBe("processing");
    expect(applicationPaymentReceipt({ ...base, claim: null, exactCharges: [], payments: [] })).toEqual({ status: "not_received" });
    expect(applicationPaymentReceipt({ ...base, claim: { ...claim, status: "expired" }, exactCharges: [], payments: [] }))
      .toEqual({ status: "not_received" });
  });

  it("uses exact refund ledger rows for partial and full refund states", () => {
    expect(applicationPaymentReceipt({ ...base, refunds: [{ manager_user_id: "manager-1", amount_cents: 2000 }] }))
      .toMatchObject({ status: "partially_refunded", principalCents: 5000, refundedCents: 2000 });
    expect(applicationPaymentReceipt({ ...base, refunds: [{ manager_user_id: "manager-1", amount_cents: 5044 }] }))
      .toMatchObject({ status: "refunded", principalCents: 5000, refundedCents: 5044 });
  });

  it("fails closed on malformed, foreign, or excessive refund records", () => {
    for (const refunds of [
      [{ manager_user_id: "manager-other", amount_cents: 100 }],
      [{ manager_user_id: "manager-1", amount_cents: 0 }],
      [{ manager_user_id: "manager-1", amount_cents: Number.NaN }],
      [{ manager_user_id: "manager-1", amount_cents: 5045 }],
    ]) {
      expect(applicationPaymentReceipt({ ...base, refunds }).status).toBe("needs_review");
    }
  });

  it("requires matching claim, charge, session, and payment ledger provenance", () => {
    expect(applicationPaymentReceipt({ ...base, exactCharges: [{ ...charge, row_data: {
      ...charge.row_data, stripeCheckoutSessionId: "cs_test_sibling",
    } }] }).status).toBe("needs_review");
    expect(applicationPaymentReceipt({ ...base, payments: [] }).status).toBe("needs_review");
    expect(applicationPaymentReceipt({ ...base, claim: { ...claim, application_id: "application-a" } }).status).toBe("needs_review");
  });

  it("does not convert an ambiguous legacy paid row into B's receipt or absence", () => {
    expect(applicationPaymentReceipt({ ...base, claim: null, exactCharges: [], payments: [],
      ambiguousLegacyCharges: [{ id: "legacy", status: "paid", row_data: { amountLabel: "$50.00" } }] }))
      .toEqual({ status: "needs_review", principalCents: 5000 });
  });
});
