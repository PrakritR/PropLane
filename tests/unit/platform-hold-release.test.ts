import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe-connect", () => ({ connectAccountReadyForAchPayouts: () => true }));

import { releaseVerifiedPlatformHoldsForOwner, reconcileReservedPlatformHoldTransfers } from "@/lib/platform-hold-release.server";

const owner = "a3155b52-294f-4b16-93cc-1bea83e5a899";
const hold = {
  id: "hold-1", owner_user_id: owner, owner_role: "manager", source: "application_fee",
  source_id: "cs_paid", amount_cents: 5000, status: "held", stripe_charge_id: "ch_paid",
  original_amount_cents: 5000, source_charge_gross_cents: 5175,
  source_payment_intent_id: "pi_paid", source_verified_at: "2026-10-04T00:00:00Z",
};
const reserved = {
  id: "attempt-1", hold_id: hold.id, attempt_key: "hold-transfer:original",
  owner_user_id: owner, destination_account_id: "acct_old",
  source_charge_id: "ch_paid", amount_cents: 5000, status: "reserved",
  component_breakdown: [{ source_id: "fee-1", recipient_net_cents: 5000 }],
  stripe_transfer_id: null, created_at: new Date().toISOString(),
};

function fixture(
  activeAttempt: typeof reserved | null = reserved,
  options?: { holdRow?: typeof hold; refundAttempts?: Array<Record<string, unknown>>;
    settledConsumption?: Array<{ source_net_cents: number }>;
    reserveError?: { code: string; message: string } },
) {
  const holdRow = options?.holdRow ?? hold;
  const profileRead = vi.fn(async () => ({ data: { stripe_connect_account_id: "acct_new" }, error: null }));
  const rpc = vi.fn(async (name: string) => ({
    data: name === "reserve_platform_hold_transfer" ? activeAttempt : true,
    error: name === "reserve_platform_hold_transfer" ? options?.reserveError ?? null : null,
  }));
  const db = {
    from: vi.fn((table: string) => {
      const result = table === "platform_payment_holds"
        ? { data: [holdRow], error: null }
        : table === "platform_hold_transfer_attempts"
          ? { data: activeAttempt ? [activeAttempt] : [], error: null }
          : table === "platform_hold_refund_attempts"
            ? { data: options?.refundAttempts ?? [], error: null }
            : table === "platform_source_consumption_legs"
              ? { data: options?.settledConsumption ?? [], error: null }
            : null;
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: profileRead }) }) };
      }
      const query: Record<string, unknown> = { then: (resolve: (value: unknown) => void) => resolve(result) };
      query.eq = vi.fn().mockReturnValue(query);
      query.order = vi.fn().mockReturnValue(query);
      query.limit = vi.fn().mockReturnValue(query);
      return { select: () => query };
    }),
    rpc,
  };
  const stripe = {
    accounts: { retrieve: vi.fn(async (id: string) => ({ id, metadata: { axis_user_id: owner } })) },
    charges: { retrieve: vi.fn(async () => ({ id: "ch_paid", paid: true, status: "succeeded",
      currency: "usd", amount: 5175, amount_refunded: 0, refunded: false, disputed: false,
      payment_intent: "pi_paid" })) },
    refunds: { list: vi.fn(async () => ({ data: [], has_more: false })) },
    transfers: { create: vi.fn(async () => ({ id: "tr_original", amount: activeAttempt?.amount_cents ?? 5000, currency: "usd",
      destination: "acct_old", source_transaction: "ch_paid" })) },
  };
  return { db, stripe, rpc, profileRead };
}

describe("source-backed platform hold release", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries an uncertain transfer with its saved original bank and Stripe key after relink", async () => {
    const f = fixture();
    const result = await releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never });
    expect(result).toEqual({ transferred: 1, pending: 0 });
    expect(f.profileRead).not.toHaveBeenCalled();
    expect(f.stripe.accounts.retrieve).toHaveBeenCalledWith("acct_old");
    expect(f.stripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 5000, destination: "acct_old", source_transaction: "ch_paid",
    }), { idempotencyKey: reserved.attempt_key });
    expect(f.rpc).toHaveBeenCalledWith("finish_platform_hold_transfer", expect.objectContaining({
      p_attempt: reserved.attempt_key, p_transfer: "tr_original",
    }));
  });

  it("daily reconciliation replays only a persisted reserved transfer", async () => {
    const f = fixture();
    const result = await reconcileReservedPlatformHoldTransfers(f.db as never, f.stripe as never);
    expect(result).toEqual({ scanned: 1, transferred: 1, pending: 0,
      truncated: false, errors: [] });
    expect(f.stripe.transfers.create).toHaveBeenCalledWith(expect.anything(),
      { idempotencyKey: reserved.attempt_key });
    const empty = fixture(null);
    const skipped = await reconcileReservedPlatformHoldTransfers(empty.db as never, empty.stripe as never);
    expect(skipped.scanned).toBe(0);
    expect(empty.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("keeps an unknown provider outcome reserved for exact-key replay", async () => {
    const f = fixture();
    const accepted = new Map<string, { id: string; amount: number; currency: string;
      destination: string; source_transaction: string }>();
    let loseResponse = true;
    f.stripe.transfers.create.mockImplementation(async (params: {
      amount: number; currency: string; destination: string; source_transaction: string;
    }, options: { idempotencyKey: string }) => {
      const created = accepted.get(options.idempotencyKey) ?? {
        id: "tr_provider_accepted", amount: params.amount, currency: params.currency,
        destination: params.destination, source_transaction: params.source_transaction,
      };
      accepted.set(options.idempotencyKey, created);
      if (loseResponse) { loseResponse = false; throw new Error("response lost after provider accepted transfer"); }
      return created;
    });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never })).rejects.toThrow(/response lost after provider accepted/);
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_hold_transfer")).toBe(false);
    await releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never });
    expect(accepted.size).toBe(1);
    expect(accepted.get(reserved.attempt_key)?.id).toBe("tr_provider_accepted");
    expect(f.stripe.transfers.create).toHaveBeenCalledTimes(2);
    expect(f.stripe.transfers.create.mock.calls.map(([, options]) => options.idempotencyKey))
      .toEqual([reserved.attempt_key, reserved.attempt_key]);
    expect(f.rpc).toHaveBeenCalledWith("finish_platform_hold_transfer", expect.objectContaining({
      p_transfer: "tr_provider_accepted", p_attempt: reserved.attempt_key,
    }));
  });

  it("does not finalize an accepted transfer when the source was externally refunded meanwhile", async () => {
    const f = fixture();
    f.stripe.charges.retrieve.mockResolvedValueOnce({ id: "ch_paid", paid: true,
      status: "succeeded", currency: "usd", amount: 5175, amount_refunded: 0,
      disputed: false, payment_intent: "pi_paid" });
    f.stripe.charges.retrieve.mockResolvedValueOnce({ id: "ch_paid", paid: true,
      status: "succeeded", currency: "usd", amount: 5175, amount_refunded: 100,
      disputed: false, payment_intent: "pi_paid" });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never }))
      .rejects.toThrow(/accounting differs/);
    expect(f.stripe.transfers.create).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_hold_transfer")).toBe(false);
  });

  it("will not reuse an ambiguous transfer key beyond the provider retention window", async () => {
    const f = fixture({ ...reserved, created_at: "2026-01-01T00:00:00Z" });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never })).rejects.toThrow(/provider reconciliation/);
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("will not create a transfer when the persisted attempt time is malformed", async () => {
    const f = fixture({ ...reserved, created_at: "unknown" });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never })).rejects.toThrow(/provider reconciliation/);
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("rejects a stored transfer destination whose Connect owner changed", async () => {
    const f = fixture();
    f.stripe.accounts.retrieve.mockResolvedValueOnce({ id: "acct_old", metadata: { axis_user_id: "other" } });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never })).rejects.toThrow(/owner review/);
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("releases only the remaining net after a source-bound succeeded partial refund", async () => {
    const f = fixture({ ...reserved, amount_cents: 3000,
      component_breakdown: [{ source_id: "fee-1", recipient_net_cents: 3000 }] }, {
      holdRow: { ...hold, amount_cents: 3000 },
      refundAttempts: [{ status: "succeeded", stripe_refund_id: "re_part",
        gross_cents: 2000, hold_debit_cents: 2000 }],
    });
    f.stripe.charges.retrieve.mockResolvedValue({ id: "ch_paid", paid: true, status: "succeeded",
      currency: "usd", amount: 5175, amount_refunded: 2000, refunded: false, disputed: false,
      payment_intent: "pi_paid" });
    f.stripe.refunds.list.mockResolvedValue({ data: [{ id: "re_part", status: "succeeded",
      amount: 2000, charge: "ch_paid" }], has_more: false });
    f.stripe.transfers.create.mockResolvedValueOnce({ id: "tr_remaining", amount: 3000,
      currency: "usd", destination: "acct_old", source_transaction: "ch_paid" });
    const result = await releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never });
    expect(result).toEqual({ transferred: 1, pending: 0 });
    expect(f.stripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 3000, source_transaction: "ch_paid",
    }), { idempotencyKey: reserved.attempt_key });
  });

  it("releases only the SQL-reserved residual while an owner debt offset remains uncleared", async () => {
    const f = fixture({ ...reserved, amount_cents: 4825,
      component_breakdown: [{ source_id: "fee-1", recipient_net_cents: 4825 }] });
    const result = await releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never });
    expect(result).toEqual({ transferred: 1, pending: 0 });
    expect(f.stripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 4825, source_transaction: "ch_paid",
    }), { idempotencyKey: reserved.attempt_key });
  });

  it("keeps settled source consumption distinct from the current residual transfer", async () => {
    const f = fixture({ ...reserved, amount_cents: 3000,
      component_breakdown: [{ source_id: "fee-1", recipient_net_cents: 3000 }] }, {
      holdRow: { ...hold, amount_cents: 4000 },
      settledConsumption: [{ source_net_cents: 1000 }],
    });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never }))
      .resolves.toEqual({ transferred: 1, pending: 0 });
    expect(f.stripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 3000 }),
      { idempotencyKey: reserved.attempt_key });
  });

  it("keeps a fully owner-reserved source pending without making a zero transfer", async () => {
    const f = fixture(null, { reserveError: {
      code: "P0001", message: "platform hold has no releasable residual",
    } });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never }))
      .resolves.toEqual({ transferred: 0, pending: 1 });
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("keeps a prior transferred residual plus reserved recovery pending", async () => {
    const f = fixture(null, { reserveError: {
      code: "P0001", message: "platform hold has no releasable residual",
    } });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never }))
      .resolves.toEqual({ transferred: 0, pending: 1 });
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith("reserve_platform_hold_transfer",
      expect.objectContaining({ p_hold: hold.id, p_charge: hold.stripe_charge_id }));
  });

  it("blocks a provider refund absent from the source-bound succeeded reservations", async () => {
    const f = fixture();
    f.stripe.charges.retrieve.mockResolvedValueOnce({ id: "ch_paid", paid: true, status: "succeeded",
      currency: "usd", amount: 5175, amount_refunded: 2000, refunded: false, disputed: false,
      payment_intent: "pi_paid" });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never })).rejects.toThrow(/refund accounting/);
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("allows remaining funds after an exactly mapped failed refund without debiting the hold", async () => {
    const f = fixture(reserved, { refundAttempts: [{ status: "failed", stripe_refund_id: "re_failed",
      terminal_provider_status: "failed", gross_cents: 2000, hold_debit_cents: 2000 }] });
    f.stripe.refunds.list.mockResolvedValue({ data: [{ id: "re_failed", status: "failed",
      amount: 2000, charge: "ch_paid" }], has_more: false });
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db as never,
      { ownerUserId: owner, stripe: f.stripe as never })).resolves.toEqual({ transferred: 1, pending: 0 });
    expect(f.stripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000 }),
      { idempotencyKey: reserved.attempt_key });
  });
});
