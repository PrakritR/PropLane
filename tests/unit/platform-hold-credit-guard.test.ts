import { describe, expect, it, vi } from "vitest";
import { creditHoldFromPaidSession, creditHoldFromPaymentIntent } from "@/lib/stripe-platform-hold.server";

describe("legacy hold credit safety gates", () => {
  const db = { from: vi.fn(() => { throw new Error("unsettled money reached database"); }) };

  it("does not credit an ACH Checkout merely because its session completed", async () => {
    const session = { status: "complete", payment_status: "unpaid", metadata: {
      platform_hold: "1", purpose: "household_charge", manager_user_id: "manager",
      hold_amount_cents: "5000",
    } };
    await expect(creditHoldFromPaidSession(db as never, session as never))
      .resolves.toEqual({ credited: false });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("does not credit an unconfirmed PaymentIntent or invent a charge ID", async () => {
    const intent = { status: "processing", latest_charge: null, metadata: {
      platform_hold: "1", purpose: "household_charge", manager_user_id: "manager",
      hold_amount_cents: "5000",
    } };
    await expect(creditHoldFromPaymentIntent(db as never, intent as never))
      .resolves.toEqual({ credited: false });
    await expect(creditHoldFromPaymentIntent(db as never, { ...intent, status: "succeeded" } as never))
      .rejects.toThrow(/actual Stripe charge/);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("does not default unknown or vendor PaymentIntent purposes to a manager hold", async () => {
    for (const purpose of [undefined, "vendor_invoice_direct_pay"]) {
      await expect(creditHoldFromPaymentIntent(db as never, { status: "succeeded", latest_charge: "ch_paid",
        metadata: { platform_hold: "1", purpose, manager_user_id: "payer", hold_amount_cents: "5000" },
      } as never)).rejects.toThrow(/no verified resident hold source/);
    }
    expect(db.from).not.toHaveBeenCalled();
  });
});
