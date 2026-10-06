import { describe, expect, it, vi } from "vitest";
import { attestPlatformDestinationSource, DestinationSourcePendingError } from "@/lib/platform-destination-source.server";

function fixture(feeCents = 35) {
  const gross = 132, destination = "acct_owned";
  const pi = { id: "pi_paid", status: "succeeded", currency: "usd", amount_received: gross,
    latest_charge: "ch_platform", transfer_data: { destination }, application_fee_amount: feeCents,
    livemode: false };
  const charge = { id: "ch_platform", paid: true, status: "succeeded", currency: "usd",
    created: Math.floor(Date.now() / 1000),
    amount: gross, amount_refunded: 0, disputed: false, payment_intent: pi.id,
    transfer_data: { destination }, transfer: "tr_exact", application_fee: feeCents ? "fee_exact" : null,
    application_fee_amount: feeCents, livemode: false };
  const transfer = { id: "tr_exact", amount: gross, currency: "usd", destination,
    source_transaction: charge.id, destination_payment: "py_connected", amount_reversed: 0,
    reversals: { data: [], has_more: false },
    livemode: false };
  const payment = { id: "py_connected", paid: true, status: "succeeded", amount: gross,
    currency: "usd", livemode: false,
    source_transfer: transfer.id, application_fee: charge.application_fee, amount_refunded: 0 };
  const fee = { id: "fee_exact", amount: feeCents, amount_refunded: 0, currency: "usd",
    refunds: { data: [], has_more: false },
    livemode: false, account: destination, charge: payment.id,
    originating_transaction: charge.id };
  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ id: destination, metadata: { axis_user_id: "owner" }, livemode: false })) },
    transfers: { retrieve: vi.fn(async () => transfer) },
    charges: { retrieve: vi.fn(async () => payment) },
    applicationFees: { retrieve: vi.fn(async () => fee) },
    refunds: { list: vi.fn(async () => ({ data: [], has_more: false })) },
  };
  const input = { paymentIntent: pi, charge, ownerUserId: "owner",
    expectedGrossCents: gross, expectedRecipientNetCents: gross - feeCents,
    expectedDestinationAccountId: destination };
  return { stripe, input, charge, transfer, fee, payment, pi };
}

describe("actual Stripe destination source attestation", () => {
  it("binds the platform charge, transfer, connected payment and fee across accounts", async () => {
    const f = fixture();
    await expect(attestPlatformDestinationSource(f.stripe as never, f.input as never))
      .resolves.toEqual({ destinationAccountId: "acct_owned", transferId: "tr_exact",
        transferGrossCents: 132, applicationFeeId: "fee_exact", applicationFeeCents: 35 });
    expect(f.stripe.charges.retrieve).toHaveBeenCalledWith("py_connected", undefined,
      { stripeAccount: "acct_owned" });
  });

  it("keeps a paid source processing while Stripe hydrates its automatic legs", async () => {
    const f = fixture();
    f.charge.transfer = null as never;
    f.charge.application_fee = null;
    await expect(attestPlatformDestinationSource(f.stripe as never, f.input as never))
      .rejects.toBeInstanceOf(DestinationSourcePendingError);
    expect(f.stripe.transfers.retrieve).not.toHaveBeenCalled();
  });

  it("allows an actual zero-fee destination without inventing an application fee", async () => {
    const f = fixture(0);
    f.pi.application_fee_amount = null as never;
    f.charge.application_fee_amount = null as never;
    await expect(attestPlatformDestinationSource(f.stripe as never, f.input as never))
      .resolves.toMatchObject({ applicationFeeId: null, applicationFeeCents: 0 });
    expect(f.stripe.applicationFees.retrieve).not.toHaveBeenCalled();
  });

  it("rejects a wrong connected recipient, fee origin, owner or refunded source", async () => {
    const wrongPayment = fixture();
    wrongPayment.payment.source_transfer = "tr_unrelated";
    await expect(attestPlatformDestinationSource(wrongPayment.stripe as never, wrongPayment.input as never))
      .rejects.toThrow(/connected payment/i);
    const wrongFee = fixture();
    wrongFee.fee.originating_transaction = "ch_unrelated";
    await expect(attestPlatformDestinationSource(wrongFee.stripe as never, wrongFee.input as never))
      .rejects.toThrow(/application fee/i);
    const wrongOwner = fixture();
    wrongOwner.stripe.accounts.retrieve.mockResolvedValueOnce({ id: "acct_owned",
      metadata: { axis_user_id: "other" }, livemode: false });
    await expect(attestPlatformDestinationSource(wrongOwner.stripe as never, wrongOwner.input as never))
      .rejects.toThrow(/does not belong/);
    const refunded = fixture();
    refunded.stripe.refunds.list.mockResolvedValueOnce({ data: [{ id: "re_pending" }], has_more: false });
    await expect(attestPlatformDestinationSource(refunded.stripe as never, refunded.input as never))
      .rejects.toThrow(/refund history/);
  });

  it("rechecks original provider legs on a verified allocation replay after refund", async () => {
    const f = fixture();
    f.charge.amount_refunded = 50;
    f.transfer.amount_reversed = 48;
    f.fee.amount_refunded = 2;
    f.stripe.refunds.list.mockResolvedValueOnce({ data: [{ id: "re_exact" }], has_more: false });
    await expect(attestPlatformDestinationSource(f.stripe as never,
      { ...f.input, allowRefundedReplay: true } as never))
      .resolves.toMatchObject({ transferId: "tr_exact", applicationFeeId: "fee_exact" });
    expect(f.stripe.refunds.list).not.toHaveBeenCalled();
  });

  it("waits for known transfer, connected-payment and fee links to hydrate", async () => {
    const noConnectedFee = fixture();
    noConnectedFee.payment.application_fee = null;
    await expect(attestPlatformDestinationSource(noConnectedFee.stripe as never, noConnectedFee.input as never))
      .rejects.toBeInstanceOf(DestinationSourcePendingError);
    const noConnectedTransfer = fixture();
    noConnectedTransfer.payment.source_transfer = null as never;
    await expect(attestPlatformDestinationSource(noConnectedTransfer.stripe as never, noConnectedTransfer.input as never))
      .rejects.toBeInstanceOf(DestinationSourcePendingError);
    const missingExactFee = fixture();
    missingExactFee.stripe.applicationFees.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("not ready"), { statusCode: 404, code: "resource_missing" }));
    await expect(attestPlatformDestinationSource(missingExactFee.stripe as never, missingExactFee.input as never))
      .rejects.toBeInstanceOf(DestinationSourcePendingError);
    const wrongConnectedFee = fixture();
    wrongConnectedFee.payment.application_fee = "fee_other";
    await expect(attestPlatformDestinationSource(wrongConnectedFee.stripe as never, wrongConnectedFee.input as never))
      .rejects.toThrow(/connected payment/i);
    const tooOld = fixture();
    tooOld.charge.created -= 21 * 60;
    tooOld.payment.source_transfer = null as never;
    await expect(attestPlatformDestinationSource(tooOld.stripe as never, tooOld.input as never))
      .rejects.toThrow(/needs source review/);
  });

  it("rejects a known wrong source even while later destination links are absent", async () => {
    const wrongTransfer = fixture();
    wrongTransfer.transfer.source_transaction = "ch_other";
    wrongTransfer.transfer.destination_payment = null as never;
    await expect(attestPlatformDestinationSource(wrongTransfer.stripe as never, wrongTransfer.input as never))
      .rejects.toThrow(/transfer differs/i);

    const wrongPayment = fixture();
    wrongPayment.payment.amount = 131;
    wrongPayment.payment.source_transfer = null as never;
    await expect(attestPlatformDestinationSource(wrongPayment.stripe as never, wrongPayment.input as never))
      .rejects.toThrow(/connected payment/i);

    const wrongFee = fixture();
    wrongFee.fee.account = "acct_other";
    wrongFee.fee.originating_transaction = null as never;
    await expect(attestPlatformDestinationSource(wrongFee.stripe as never, wrongFee.input as never))
      .rejects.toThrow(/application fee/i);
  });
});
