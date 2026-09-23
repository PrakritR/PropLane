import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { residentProcessingFeeCents } from "@/lib/payment-policy";

function captureStripe() {
  const calls: Record<string, unknown>[] = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { id: "cs_test", url: "https://checkout.test/pay", client_secret: null };
        },
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

describe("vendor pay — manager pays Stripe’s cost only", () => {
  const invoiceCents = 48_000;

  it("destination: manager total = invoice + fee; vendor payout = invoice", async () => {
    const { stripe, calls } = captureStripe();
    const fee = residentProcessingFeeCents(invoiceCents, "ach");
    const result = await createAxisAchCheckoutSession(stripe, {
      residentEmail: "manager@example.com",
      amountCents: invoiceCents,
      productName: "Vendor invoice · Kitchen leak",
      metadata: { purpose: "vendor_invoice_pay" },
      mode: "hosted",
      destinationAccountId: "acct_vendor",
      paymentMethod: "ach",
      feePayer: "resident",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/cancel",
    });
    const pid = calls[0]!.payment_intent_data as Record<string, unknown>;
    expect(result.totalCents).toBe(invoiceCents + fee);
    expect(result.processingFeeCents).toBe(fee);
    expect(pid.application_fee_amount).toBe(fee);
    expect(pid.transfer_data).toEqual({ destination: "acct_vendor" });
    expect((calls[0]!.metadata as Record<string, string>).manager_payout_cents).toBe(String(invoiceCents));
  });

  it("hold: manager still pays invoice + fee; no destination", async () => {
    const { stripe, calls } = captureStripe();
    const fee = residentProcessingFeeCents(invoiceCents, "ach");
    const result = await createAxisAchCheckoutSession(stripe, {
      residentEmail: "manager@example.com",
      amountCents: invoiceCents,
      productName: "Vendor invoice · Kitchen leak",
      metadata: { purpose: "vendor_invoice_pay" },
      mode: "hosted",
      paymentMethod: "ach",
      feePayer: "resident",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/cancel",
    });
    const pid = calls[0]!.payment_intent_data as Record<string, unknown>;
    expect(result.totalCents).toBe(invoiceCents + fee);
    expect(pid.transfer_data).toBeUndefined();
    expect((pid.metadata as Record<string, string>).platform_hold).toBe("1");
    expect((pid.metadata as Record<string, string>).hold_amount_cents).toBe(String(invoiceCents));
  });
});
