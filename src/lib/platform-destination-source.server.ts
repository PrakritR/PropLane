import "server-only";

import type Stripe from "stripe";

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

/** Stripe can report a succeeded charge before its automatic destination legs hydrate. */
export class DestinationSourcePendingError extends Error {}

function stillHydrating(charge: Stripe.Charge): boolean {
  const createdMs = charge.created * 1000;
  const ageMs = Date.now() - createdMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 20 * 60 * 1000;
}

function missingExactProviderObject(error: unknown): boolean {
  const candidate = error as { statusCode?: unknown; code?: unknown } | null;
  return candidate?.statusCode === 404 && candidate.code === "resource_missing";
}

async function loadHydratingLeg<T>(load: () => Promise<T>, charge: Stripe.Charge): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (missingExactProviderObject(error) && stillHydrating(charge)) {
      throw new DestinationSourcePendingError("Destination provider leg is still processing.");
    }
    throw error;
  }
}

function waitForMissingLink(charge: Stripe.Charge): never {
  if (stillHydrating(charge)) {
    throw new DestinationSourcePendingError("Destination provider link is still processing.");
  }
  throw new Error("Destination provider link needs source review.");
}

/**
 * Attest the recipient net of an automatic destination charge from the
 * provider's actual transfer and fee legs. The connected payment is read in
 * the captured destination account; current bank settings or metadata alone
 * cannot establish where this captured money went.
 */
export async function attestPlatformDestinationSource(
  stripe: Stripe,
  input: {
    paymentIntent: Stripe.PaymentIntent;
    charge: Stripe.Charge;
    ownerUserId: string;
    expectedGrossCents: number;
    expectedRecipientNetCents: number;
    expectedDestinationAccountId: string;
    /** Only an already verified, exact allocation may replay after a refund. */
    allowRefundedReplay?: boolean;
  },
): Promise<{
  destinationAccountId: string;
  transferId: string;
  transferGrossCents: number;
  applicationFeeId: string | null;
  applicationFeeCents: number;
}> {
  const { paymentIntent: pi, charge, ownerUserId, expectedGrossCents: gross,
    expectedRecipientNetCents: net, expectedDestinationAccountId: destination } = input;
  if (!ownerUserId || !destination || !Number.isSafeInteger(gross) || gross <= 0 ||
      !Number.isSafeInteger(net) || net <= 0 || net > gross ||
      pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount_received !== gross || idOf(pi.latest_charge) !== charge.id ||
      idOf(pi.transfer_data?.destination) !== destination ||
      (pi.transfer_data?.amount != null && pi.transfer_data.amount !== gross) ||
      !charge.paid || charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== gross || charge.disputed ||
      (!input.allowRefundedReplay && charge.amount_refunded !== 0) ||
      idOf(charge.payment_intent) !== pi.id ||
      idOf(charge.transfer_data?.destination) !== destination ||
      (charge.transfer_data?.amount != null && charge.transfer_data.amount !== gross) ||
      (pi.application_fee_amount ?? 0) !== gross - net ||
      (charge.application_fee_amount ?? 0) !== gross - net ||
      charge.livemode !== pi.livemode) {
    throw new Error("Destination payment does not match its captured recipient and amount.");
  }
  const account = await stripe.accounts.retrieve(destination);
  if (account.id !== destination || account.metadata?.axis_user_id !== ownerUserId) {
    throw new Error("Captured destination does not belong to the payment recipient.");
  }
  const transferId = idOf(charge.transfer);
  const expectedFee = gross - net;
  const feeId = idOf(charge.application_fee);
  if (!transferId || (expectedFee > 0 && !feeId)) {
    waitForMissingLink(charge);
  }
  const transfer = await loadHydratingLeg(() => stripe.transfers.retrieve(transferId), charge);
  if (transfer.id !== transferId || transfer.amount !== gross || transfer.currency !== "usd" ||
      idOf(transfer.destination) !== destination ||
      idOf(transfer.source_transaction) !== charge.id ||
      transfer.livemode !== pi.livemode ||
      (!input.allowRefundedReplay && (transfer.amount_reversed !== 0 ||
        (transfer.reversals?.data.length ?? 0) > 0 || transfer.reversals?.has_more))) {
    throw new Error("Destination transfer differs from the captured platform charge.");
  }
  const connectedPaymentId = idOf(transfer.destination_payment);
  if (!connectedPaymentId) {
    waitForMissingLink(charge);
  }
  const connectedPayment = await loadHydratingLeg(() => stripe.charges.retrieve(
    connectedPaymentId, undefined, { stripeAccount: destination }), charge);
  if (connectedPayment.id !== connectedPaymentId || !connectedPayment.paid ||
      connectedPayment.status !== "succeeded" || connectedPayment.amount !== gross ||
      connectedPayment.currency !== "usd" || connectedPayment.livemode !== pi.livemode ||
      (idOf(connectedPayment.source_transfer) !== null &&
        idOf(connectedPayment.source_transfer) !== transfer.id) ||
      (idOf(connectedPayment.application_fee) !== null &&
        idOf(connectedPayment.application_fee) !== feeId) ||
      (!input.allowRefundedReplay && connectedPayment.amount_refunded !== 0)) {
    throw new Error("Connected payment is not the captured destination transfer.");
  }
  if (!idOf(connectedPayment.source_transfer) ||
      (expectedFee > 0 && !idOf(connectedPayment.application_fee))) {
    waitForMissingLink(charge);
  }
  if (feeId) {
    const fee = await loadHydratingLeg(() => stripe.applicationFees.retrieve(feeId), charge);
    if (fee.id !== feeId || fee.amount !== expectedFee ||
        (!input.allowRefundedReplay && (fee.amount_refunded !== 0 ||
          fee.refunds.data.length > 0 || fee.refunds.has_more)) ||
        fee.currency !== "usd" || fee.livemode !== pi.livemode ||
        idOf(fee.account) !== destination ||
        (idOf(fee.charge) !== null && idOf(fee.charge) !== connectedPayment.id) ||
        (idOf(fee.originating_transaction) !== null &&
          idOf(fee.originating_transaction) !== charge.id)) {
      throw new Error("Application fee differs from the captured recipient net.");
    }
    if (!idOf(fee.charge) || !idOf(fee.originating_transaction)) {
      waitForMissingLink(charge);
    }
  } else if (expectedFee !== 0) {
    waitForMissingLink(charge);
  }
  if (!input.allowRefundedReplay) {
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
    if (refunds.data.length > 0 || refunds.has_more) {
      throw new Error("Destination source has unresolved refund history.");
    }
  }
  return { destinationAccountId: destination, transferId: transfer.id,
    transferGrossCents: transfer.amount, applicationFeeId: feeId,
    applicationFeeCents: expectedFee };
}
