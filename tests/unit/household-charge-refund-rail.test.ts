import { beforeEach, describe, expect, it, vi } from "vitest";

const runReservedPlatformMoneyRefund = vi.fn();
vi.mock("@/lib/platform-money-refund.server", () => ({
  runReservedPlatformMoneyRefund: (...args: unknown[]) => runReservedPlatformMoneyRefund(...args),
}));

import { refundPaidHouseholdCharge } from "@/lib/household-charge-refund-rail.server";

const chargeId = "charge-a";
const stripeChargeId = "ch_paid";
const owner = "6746a8a8-b7a8-4040-922d-538501c29722";
const holdId = "6a65b330-d052-4970-86b1-ce3c98d44bd1";

type Hold = {
  id: string;
  owner_user_id: string;
  owner_role: string;
  stripe_charge_id: string;
  source_components: Array<{ source_id: string; principal_cents: number }> | null;
};

function fixture(holds: Hold[], holdsError = false) {
  const stripe = {
    refunds: { create: vi.fn(async () => ({ id: "re_legacy", status: "succeeded" })) },
  };
  const db = {
    from: vi.fn(() => {
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        limit: vi.fn(async () => (holdsError
          ? { data: null, error: { message: "boom" } }
          : { data: holds, error: null })),
      };
      return query;
    }),
  };
  return { stripe, db };
}

const input = {
  chargeId,
  stripeChargeId,
  amountCents: 5000,
  idempotencyKey: "charge-refund:charge-a:5000:1",
  metadata: { proplane_charge_id: chargeId, kind: "charge_refund" },
};

const centralHold: Hold = {
  id: holdId,
  owner_user_id: owner,
  owner_role: "manager",
  stripe_charge_id: stripeChargeId,
  source_components: [{ source_id: chargeId, principal_cents: 5000 }],
};

describe("refundPaidHouseholdCharge", () => {
  beforeEach(() => {
    runReservedPlatformMoneyRefund.mockReset();
  });

  it("reverses the transfer on a legacy destination charge with no platform hold", async () => {
    const { stripe, db } = fixture([]);

    const result = await refundPaidHouseholdCharge(stripe as never, db as never, input);

    expect(result).toEqual({ refundId: "re_legacy", rail: "destination" });
    expect(runReservedPlatformMoneyRefund).not.toHaveBeenCalled();
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        charge: stripeChargeId,
        amount: 5000,
        reverse_transfer: true,
      }),
      { idempotencyKey: input.idempotencyKey },
    );
  });

  it("refunds a central platform capture through its reservation, never with reverse_transfer", async () => {
    const { stripe, db } = fixture([centralHold]);
    runReservedPlatformMoneyRefund.mockResolvedValue({
      status: "succeeded", refundId: "re_central", recipientNetDebitCents: 5000, vendorFeeShareCents: 0,
    });

    const result = await refundPaidHouseholdCharge(stripe as never, db as never, input);

    expect(result).toEqual({ refundId: "re_central", rail: "central" });
    // Stripe only ever sees the refund the reservation creates: a marked capture has no
    // transfer to reverse, and a refund created here would carry no attempt metadata.
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(runReservedPlatformMoneyRefund).toHaveBeenCalledWith(stripe, db, {
      ownerUserId: owner,
      holdId,
      principalCents: 5000,
      attemptKey: input.idempotencyKey,
      components: [{ sourceId: chargeId, principalCents: 5000 }],
    });
  });

  it("reserves only the refunded charge's component out of a whole-cart capture", async () => {
    const { stripe, db } = fixture([{
      ...centralHold,
      source_components: [
        { source_id: "charge-b", principal_cents: 9000 },
        { source_id: chargeId, principal_cents: 5000 },
      ],
    }]);
    runReservedPlatformMoneyRefund.mockResolvedValue({
      status: "succeeded", refundId: "re_central", recipientNetDebitCents: 2500, vendorFeeShareCents: 0,
    });

    await refundPaidHouseholdCharge(stripe as never, db as never, { ...input, amountCents: 2500 });

    expect(runReservedPlatformMoneyRefund).toHaveBeenCalledWith(stripe, db, expect.objectContaining({
      components: [{ sourceId: chargeId, principalCents: 2500 }],
    }));
  });

  it("refuses a refund above the charge's captured principal before any provider call", async () => {
    const { stripe, db } = fixture([centralHold]);

    await expect(refundPaidHouseholdCharge(stripe as never, db as never, { ...input, amountCents: 5001 }))
      .rejects.toThrow(/captured principal/i);
    expect(runReservedPlatformMoneyRefund).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("refuses a capture whose components do not cover the charge", async () => {
    const { stripe, db } = fixture([{ ...centralHold, source_components: [{ source_id: "charge-b", principal_cents: 5000 }] }]);

    await expect(refundPaidHouseholdCharge(stripe as never, db as never, input)).rejects.toThrow(/needs review/i);
    expect(runReservedPlatformMoneyRefund).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("throws on a failed provider refund so the caller records no refunded amount", async () => {
    const { stripe, db } = fixture([centralHold]);
    runReservedPlatformMoneyRefund.mockResolvedValue({
      status: "failed", refundId: "", recipientNetDebitCents: 0, vendorFeeShareCents: 0,
    });

    await expect(refundPaidHouseholdCharge(stripe as never, db as never, input))
      .rejects.toThrow(/nothing was refunded/i);
  });

  it("refuses an ambiguous allocation instead of guessing a rail", async () => {
    const { stripe, db } = fixture([centralHold, { ...centralHold, id: "other-hold" }]);

    await expect(refundPaidHouseholdCharge(stripe as never, db as never, input)).rejects.toThrow(/ambiguous/i);
    expect(runReservedPlatformMoneyRefund).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("refuses when the allocation read fails rather than falling back to a transfer reversal", async () => {
    const { stripe, db } = fixture([], true);

    await expect(refundPaidHouseholdCharge(stripe as never, db as never, input)).rejects.toThrow(/recipient allocation/i);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
});
