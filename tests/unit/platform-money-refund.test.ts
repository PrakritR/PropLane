import { describe, expect, it, vi } from "vitest";
import { runReservedPlatformMoneyRefund } from "@/lib/platform-money-refund.server";

const owner = "6746a8a8-b7a8-4040-922d-538501c29722";
const holdId = "6a65b330-d052-4970-86b1-ce3c98d44bd1";
const attemptKey = "refund:owned-source:one";

function fixture(transferred = false, central = false) {
  const attempt = {
    id: "attempt-1", hold_id: holdId, payout_id: null,
    owner_user_id: owner, attempt_key: attemptKey,
    gross_cents: 5000, principal_cents: 5000, source_charge_id: "ch_paid",
    provider_reason: "requested_by_customer", reverse_transfer: false,
    refund_application_fee: false, hold_debit_cents: 5000, fee_share_cents: 0,
    transfer_reversal_cents: transferred ? 5000 : 0,
    refund_components: [{ source_id: "charge-a", principal_cents: 5000 }],
    recipient_debit_components: [{ source_id: "charge-a", principal_cents: 5000,
      recipient_debit_cents: 5000 }],
    status: "reserved", stripe_refund_id: null as string | null,
    terminal_provider_status: null as string | null,
    reversal_status: null as string | null, stripe_reversal_id: null as string | null,
    created_at: new Date().toISOString(),
  };
  const hold = { id: holdId, owner_user_id: owner, owner_role: "manager",
    status: transferred ? "transferred" : "held",
    stripe_charge_id: "ch_paid", stripe_transfer_id: transferred ? "tr_source" : null,
    source_application_fee_id: null as string | null,
    source_allocation_mode: central || !transferred ? "hold" : "destination",
    source_charge_gross_cents: 5000, source_payment_intent_id: "pi_paid",
    source_verified_at: "2026-10-04T00:00:00Z" };
  const refund = { id: "re_exact", charge: "ch_paid", amount: 5000,
    currency: "usd", status: "succeeded", created: 1791100000,
    metadata: { platform_refund_attempt: attempt.id } };
  const reversal = { id: "trr_exact", amount: 5000, transfer: "tr_source", created: 1791186400,
    source_refund: null, metadata: { platform_refund_attempt: attempt.id,
      platform_refund_id: refund.id } };
  const providerReversals: typeof reversal[] = [];
  const transferLegs = central ? ["a", "b"].map((suffix) => ({
    id: `leg-${suffix}`, refund_attempt_id: attempt.id, transfer_attempt_id: `source-${suffix}`,
    hold_id: holdId, source_charge_id: "ch_paid", source_transfer_id: `tr_${suffix}`,
    amount_cents: 2500, component_breakdown: [{ source_id: "charge-a", recipient_net_cents: 2500 }],
    status: "reserved", stripe_reversal_id: null as string | null,
    reversed_at: null as string | null,
  })) : [];
  const sourceTransfers = central ? transferLegs.map((leg) => ({
    id: leg.transfer_attempt_id, hold_id: holdId, source_charge_id: "ch_paid",
    amount_cents: 2500, stripe_transfer_id: leg.source_transfer_id, status: "created",
  })) : [];
  const centralReversals = new Map<string, typeof reversal[]>();
  const stripe = {
    charges: { retrieve: vi.fn(async () => ({ id: "ch_paid", paid: true,
      status: "succeeded", currency: "usd", amount: 5000, amount_refunded: 0,
      disputed: false, payment_intent: "pi_paid" })) },
    refunds: { create: vi.fn(async () => refund), retrieve: vi.fn(async () => refund),
      list: vi.fn(async () => ({ data: [], has_more: false })) },
    transfers: { retrieve: vi.fn(async (id: string) => ({ id,
      source_transaction: "ch_paid", amount: central ? 2500 : 5000,
      amount_reversed: central ? (centralReversals.get(id) ?? []).reduce((sum, item) => sum + item.amount, 0)
        : providerReversals.reduce((sum, item) => sum + item.amount, 0),
      reversals: { data: [], has_more: false } })),
      listReversals: vi.fn(async (id: string) => ({
        data: central ? [...(centralReversals.get(id) ?? [])] : [...providerReversals], has_more: false })),
      createReversal: vi.fn(async (id: string, params: { amount: number; metadata: Record<string, string> }) => {
        if (central) {
          const created = { ...reversal, id: `trr_${id}`, amount: params.amount,
            transfer: id, metadata: params.metadata };
          const existing = centralReversals.get(id) ?? [];
          if (!existing.some((item) => item.id === created.id)) centralReversals.set(id, [...existing, created]);
          return created;
        }
        if (!providerReversals.some((item) => item.id === reversal.id)) providerReversals.push(reversal);
        return reversal;
      }),
      retrieveReversal: vi.fn(async () => reversal) },
    applicationFees: { retrieve: vi.fn(async () => ({ id: "fee_source", amount_refunded: 0,
      refunds: { data: [], has_more: false } })) },
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "reserve_platform_money_refund") return { data: { ...attempt }, error: null };
    if (name === "stamp_platform_pending_refund") {
      attempt.stripe_refund_id = String(args.p_refund);
    } else if (name === "finish_platform_money_refund") {
      if (attempt.status !== "succeeded") {
        attempt.status = "succeeded";
        attempt.stripe_refund_id = String(args.p_refund);
        attempt.reversal_status = transferred ? "pending" : "not_required";
        if (!transferred) hold.status = "refunded";
      }
    } else if (name === "finish_platform_transfer_reversal") {
      attempt.reversal_status = "succeeded";
      attempt.stripe_reversal_id = String(args.p_reversal);
      hold.status = "refunded";
    } else if (name === "finish_platform_refund_transfer_leg") {
      const leg = transferLegs.find((row) => row.source_transfer_id === args.p_source_transfer);
      expect(leg).toBeDefined();
      leg!.status = "created";
      leg!.stripe_reversal_id = String(args.p_reversal);
      leg!.reversed_at = String(args.p_reversed_at);
      if (transferLegs.every((row) => row.status === "created")) attempt.reversal_status = "succeeded";
    } else if (name === "fail_platform_money_refund") {
      attempt.status = "failed";
      attempt.stripe_refund_id = String(args.p_refund);
      attempt.terminal_provider_status = "failed";
    } else if (name === "book_platform_refund_component") {
      expect(args).toMatchObject({ p_attempt: attemptKey });
      expect(attempt.refund_components.some((component) =>
        component.source_id === args.p_component_source)).toBe(true);
    } else if (name === "book_platform_refund_recovery_component") {
      expect(args).toMatchObject({ p_attempt: attemptKey,
        p_reversal_created_at: new Date(reversal.created * 1000).toISOString() });
      expect(attempt.recipient_debit_components.some((component) =>
        component.source_id === args.p_component_source && component.recipient_debit_cents > 0))
        .toBe(true);
    } else if (name === "book_platform_refund_transfer_recovery_component") {
      expect(args).toMatchObject({ p_attempt: attemptKey, p_component_source: "charge-a" });
      expect(transferLegs.some((leg) => leg.stripe_reversal_id === args.p_reversal &&
        leg.status === "created")).toBe(true);
    } else throw new Error(`Unexpected RPC ${name}`);
    return { data: true, error: null };
  });
  const db = {
    rpc,
    from: vi.fn((table: string) => {
      const result = () => ({ data: table === "platform_hold_refund_attempts"
        ? { ...attempt } : { ...hold }, error: null });
      const query: Record<string, unknown> = {
        eq: () => query,
        maybeSingle: vi.fn(async () => result()),
        then: (resolve: (value: unknown) => void) => resolve({
          data: table === "platform_hold_refund_attempts"
            ? [{ ...attempt }] : table === "platform_hold_refund_transfer_legs"
              ? transferLegs.map((leg) => ({ ...leg })) : table === "platform_hold_transfer_attempts"
                ? sourceTransfers.map((transfer) => ({ ...transfer })) : [{ ...hold }], error: null,
        }),
      };
      return { select: () => query };
    }),
  };
  const input = { ownerUserId: owner, holdId, principalCents: 5000, attemptKey };
  return { db, stripe, input, attempt, refund, reversal, rpc, hold, providerReversals,
    transferLegs, centralReversals };
}

describe("source-reserved provider refund", () => {
  it("settles a full held refund once without inventing a transfer reversal", async () => {
    const f = fixture();
    const result = await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(result).toEqual({ status: "succeeded", refundId: "re_exact",
      recipientNetDebitCents: 5000, vendorFeeShareCents: 0 });
    expect(f.stripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({
      charge: "ch_paid", amount: 5000, reverse_transfer: false,
      refund_application_fee: false,
    }), { idempotencyKey: attemptKey });
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.refunds.retrieve).toHaveBeenCalledWith("re_exact");
  });

  it("retains the same key after a provider-accepted refund whose response is lost", async () => {
    const f = fixture();
    const accepted = new Map<string, typeof f.refund>();
    let loseResponse = true;
    f.stripe.refunds.create.mockImplementation(async (_params, options) => {
      const saved = accepted.get(options.idempotencyKey) ?? f.refund;
      accepted.set(options.idempotencyKey, saved);
      if (loseResponse) { loseResponse = false; throw new Error("response lost"); }
      return saved;
    });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow("response lost");
    expect(f.attempt.status).toBe("reserved");
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(accepted.size).toBe(1);
    expect(f.stripe.refunds.create.mock.calls.map(([, options]) => options.idempotencyKey))
      .toEqual([attemptKey, attemptKey]);
  });

  it("adopts only its exact provider refund after response loss even beyond key retention", async () => {
    const f = fixture();
    f.attempt.created_at = "2026-01-01T00:00:00Z";
    f.stripe.charges.retrieve.mockResolvedValueOnce({ id: "ch_paid", paid: true,
      status: "succeeded", currency: "usd", amount: 5000, amount_refunded: 5000,
      disputed: false, payment_intent: "pi_paid" });
    f.stripe.refunds.list.mockResolvedValueOnce({ data: [f.refund], has_more: false });
    const result = await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(result.status).toBe("succeeded");
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
    expect(f.attempt.stripe_refund_id).toBe("re_exact");
  });

  it("rejects an aged exact refund with an automatic raw reversal before a second reversal", async () => {
    const f = fixture(true);
    f.attempt.created_at = "2026-01-01T00:00:00Z";
    f.stripe.charges.retrieve.mockResolvedValueOnce({ id: "ch_paid", paid: true,
      status: "succeeded", currency: "usd", amount: 5000, amount_refunded: 5000,
      disputed: false, payment_intent: "pi_paid" });
    f.stripe.refunds.list.mockResolvedValueOnce({ data: [{ ...f.refund,
      transfer_reversal: "trr_auto" }], has_more: false });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/differs from reserved source/);
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_money_refund")).toBe(false);
  });

  it("refuses a separate refunded application fee before settling recipient debt", async () => {
    const f = fixture(true);
    f.hold.source_application_fee_id = "fee_source";
    f.stripe.applicationFees.retrieve.mockResolvedValueOnce({ id: "fee_source",
      amount_refunded: 175, refunds: { data: [{ id: "fr_auto" }], has_more: false } });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/application fee has unreserved provider recovery/);
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_money_refund")).toBe(true);
    expect(f.rpc.mock.calls.some(([name]) => name === "book_platform_refund_component")).toBe(true);
  });

  it("refuses a separate provider refund even if the new reservation has remaining principal", async () => {
    const f = fixture();
    f.stripe.charges.retrieve.mockResolvedValueOnce({ id: "ch_paid", paid: true,
      status: "succeeded", currency: "usd", amount: 5000, amount_refunded: 100,
      disputed: false, payment_intent: "pi_paid" });
    f.stripe.refunds.list.mockResolvedValueOnce({ data: [{ ...f.refund,
      id: "re_external", amount: 100, metadata: {} }], has_more: false });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/unmapped provider refund/);
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("persists a pending refund ID and settles only after provider success", async () => {
    const f = fixture();
    f.stripe.refunds.create.mockResolvedValueOnce({ ...f.refund, status: "pending" });
    const pending = await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(pending.status).toBe("pending");
    expect(f.attempt.status).toBe("reserved");
    expect(f.attempt.stripe_refund_id).toBe("re_exact");
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_money_refund")).toBe(false);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.refunds.retrieve).toHaveBeenCalledWith("re_exact");
    expect(f.attempt.status).toBe("succeeded");
  });

  it("does not return stale pending when the webhook settled the exact refund before stamp", async () => {
    const f = fixture(true);
    f.stripe.refunds.create.mockResolvedValueOnce({ ...f.refund, status: "pending" });
    const baseRpc = f.db.rpc;
    f.db.rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "stamp_platform_pending_refund") {
        f.attempt.status = "succeeded";
        f.attempt.stripe_refund_id = "re_exact";
        f.attempt.reversal_status = "pending";
        return { data: false, error: null };
      }
      return baseRpc(name, args);
    });
    const result = await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(result.status).toBe("succeeded");
    expect(f.stripe.refunds.retrieve).toHaveBeenCalledWith("re_exact");
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(f.attempt.reversal_status).toBe("succeeded");
  });

  it("reverses exactly the persisted recipient debit for a transferred source", async () => {
    const f = fixture(true);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledWith("tr_source",
      expect.objectContaining({ amount: 5000, metadata: {
        platform_refund_attempt: "attempt-1", platform_refund_id: "re_exact",
      } }), { idempotencyKey: `${attemptKey}:reversal` });
    expect(f.attempt.reversal_status).toBe("succeeded");
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(f.stripe.transfers.retrieveReversal).toHaveBeenCalledWith("tr_source", "trr_exact");
  });

  it("reverses and books two central transfer legs independently after the payer fact", async () => {
    const f = fixture(true, true);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(2);
    expect(f.stripe.transfers.createReversal.mock.calls.map(([source, params, options]) =>
      [source, params.amount, options.idempotencyKey])).toEqual([
      ["tr_a", 2500, `${attemptKey}:reversal:leg-a`],
      ["tr_b", 2500, `${attemptKey}:reversal:leg-b`],
    ]);
    expect(f.rpc.mock.calls.filter(([name]) => name === "finish_platform_refund_transfer_leg"))
      .toHaveLength(2);
    expect(f.rpc.mock.calls.filter(([name]) => name === "book_platform_refund_transfer_recovery_component"))
      .toHaveLength(2);
    const payerBooking = f.rpc.mock.calls.findIndex(([name]) => name === "book_platform_refund_component");
    const firstReversal = f.stripe.transfers.createReversal.mock.invocationCallOrder[0];
    expect(f.rpc.mock.invocationCallOrder[payerBooking]).toBeLessThan(firstReversal);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(2);
    expect(f.stripe.transfers.retrieveReversal).not.toHaveBeenCalled();
  });

  it("keeps completed central legs and retries only the unresolved exact leg", async () => {
    const f = fixture(true, true);
    let loseSecond = true;
    const create = f.stripe.transfers.createReversal.getMockImplementation()!;
    f.stripe.transfers.createReversal.mockImplementation(async (...args) => {
      if (args[0] === "tr_b" && loseSecond) {
        loseSecond = false;
        throw new Error("second reversal response lost");
      }
      return create(...args);
    });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/second reversal response lost/);
    expect(f.transferLegs.map((leg) => leg.status)).toEqual(["created", "reserved"]);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.transfers.createReversal.mock.calls.map(([source]) => source))
      .toEqual(["tr_a", "tr_b", "tr_b"]);
    expect(f.transferLegs.map((leg) => leg.status)).toEqual(["created", "created"]);
  });

  it("adopts a provider-accepted central leg after its response was lost", async () => {
    const f = fixture(true, true);
    const create = f.stripe.transfers.createReversal.getMockImplementation()!;
    let loseSecond = true;
    f.stripe.transfers.createReversal.mockImplementation(async (...args) => {
      const accepted = await create(...args);
      if (args[0] === "tr_b" && loseSecond) {
        loseSecond = false;
        throw new Error("accepted reversal response lost");
      }
      return accepted;
    });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/accepted reversal response lost/);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.transfers.createReversal.mock.calls.map(([source]) => source))
      .toEqual(["tr_a", "tr_b"]);
    expect(f.transferLegs.map((leg) => leg.status)).toEqual(["created", "created"]);
  });

  it("records the payer refund but blocks an unrelated raw central reversal", async () => {
    const f = fixture(true, true);
    f.centralReversals.set("tr_a", [{ ...f.reversal, id: "trr_external", amount: 2500,
      transfer: "tr_a", metadata: { platform_refund_attempt: "other",
        platform_refund_id: f.refund.id } }]);
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/unreserved provider recovery/);
    expect(f.rpc.mock.calls.some(([name]) => name === "book_platform_refund_component")).toBe(true);
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("finishes a vendor central vector without calling manager recovery books", async () => {
    const f = fixture(true, true);
    f.hold.owner_role = "vendor";
    Object.assign(f.attempt, { payout_id: "payout-1" });
    Object.assign(f.input, { payoutId: "payout-1" });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .resolves.toMatchObject({ status: "succeeded" });
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls.some(([name]) => name === "book_platform_refund_component" ||
      name === "book_platform_refund_transfer_recovery_component")).toBe(false);
  });

  it("books a destination payer refund before a raw reversal blocks recipient settlement", async () => {
    const f = fixture(true);
    f.providerReversals.push({ ...f.reversal, id: "trr_external",
      metadata: { platform_refund_attempt: "other", platform_refund_id: f.refund.id } });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/unreserved provider recovery/);
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_money_refund")).toBe(true);
    expect(f.rpc.mock.calls.some(([name]) => name === "book_platform_refund_component")).toBe(true);
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("keeps the payer fact when a destination reversal read is unavailable", async () => {
    const f = fixture(true);
    f.stripe.transfers.listReversals.mockRejectedValueOnce(new Error("provider reversal read unavailable"));
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/provider reversal read unavailable/);
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_money_refund")).toBe(true);
    expect(f.rpc.mock.calls.some(([name]) => name === "book_platform_refund_component")).toBe(true);
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("keeps the refund settled but reversal pending after ambiguous provider response", async () => {
    const f = fixture(true);
    let loseResponse = true;
    f.stripe.transfers.createReversal.mockImplementation(async () => {
      if (loseResponse) { loseResponse = false; throw new Error("reversal response lost"); }
      return f.reversal;
    });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow("reversal response lost");
    expect(f.attempt.status).toBe("succeeded");
    expect(f.attempt.reversal_status).toBe("pending");
    expect(f.rpc).toHaveBeenCalledWith("book_platform_refund_component", {
      p_attempt: attemptKey, p_component_source: "charge-a",
      p_refunded_at: new Date(f.refund.created * 1000).toISOString(),
    });
    const booking = f.rpc.mock.invocationCallOrder.find((_, index) =>
      f.rpc.mock.calls[index]?.[0] === "book_platform_refund_component");
    expect(booking).toBeLessThan(f.stripe.transfers.createReversal.mock.invocationCallOrder[0]);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.transfers.createReversal.mock.calls.map(([, , options]) => options.idempotencyKey))
      .toEqual([`${attemptKey}:reversal`, `${attemptKey}:reversal`]);
    expect(f.attempt.reversal_status).toBe("succeeded");
  });

  it("retains a succeeded payer refund when its canonical journal write fails, then repairs before reversal", async () => {
    const f = fixture(true);
    const original = f.rpc.getMockImplementation()!;
    let failBooking = true;
    f.rpc.mockImplementation(async (name, args) => {
      if (name === "book_platform_refund_component" && failBooking) {
        failBooking = false;
        return { data: null, error: { message: "temporary ledger failure" } };
      }
      return original(name, args);
    });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/book_platform_refund_component/);
    expect(f.attempt.status).toBe("succeeded");
    expect(f.attempt.reversal_status).toBe("pending");
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls.filter(([name]) => name === "book_platform_refund_component"))
      .toHaveLength(2);
  });

  it("repairs a lost recovery-journal write without creating a second provider reversal", async () => {
    const f = fixture(true);
    const original = f.rpc.getMockImplementation()!;
    let failRecovery = true;
    f.rpc.mockImplementation(async (name, args) => {
      if (name === "book_platform_refund_recovery_component" && failRecovery) {
        failRecovery = false;
        return { data: null, error: { message: "temporary journal failure" } };
      }
      return original(name, args);
    });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/book_platform_refund_recovery_component/);
    expect(f.attempt.status).toBe("succeeded");
    expect(f.attempt.reversal_status).toBe("succeeded");
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls.filter(([name]) => name === "book_platform_refund_recovery_component"))
      .toHaveLength(2);
  });

  it("recovers only the positive net component when a mixed refund has an exhausted income component", async () => {
    const f = fixture(true);
    f.attempt.refund_components = [
      { source_id: "income-spent", principal_cents: 2000 },
      { source_id: "deposit-owned", principal_cents: 3000 },
    ];
    f.attempt.recipient_debit_components = [
      { source_id: "income-spent", principal_cents: 2000, recipient_debit_cents: 0 },
      { source_id: "deposit-owned", principal_cents: 3000, recipient_debit_cents: 3000 },
    ];
    f.attempt.hold_debit_cents = 3000;
    f.reversal.amount = 3000;
    await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(f.rpc.mock.calls.filter(([name]) => name === "book_platform_refund_component")
      .map(([, args]) => args.p_component_source)).toEqual(["income-spent", "deposit-owned"]);
    expect(f.rpc.mock.calls.filter(([name]) => name === "book_platform_refund_recovery_component")
      .map(([, args]) => args.p_component_source)).toEqual(["deposit-owned"]);
    expect(f.stripe.transfers.createReversal).toHaveBeenCalledWith("tr_source",
      expect.objectContaining({ amount: 3000 }), expect.any(Object));
  });

  it("adopts an exact accepted reversal after its response was lost beyond key retention", async () => {
    const f = fixture(true);
    f.attempt.status = "succeeded";
    f.attempt.stripe_refund_id = f.refund.id;
    f.attempt.reversal_status = "pending";
    f.attempt.created_at = "2026-01-01T00:00:00Z";
    f.providerReversals.push(f.reversal);
    const result = await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(result.status).toBe("succeeded");
    expect(f.attempt.reversal_status).toBe("succeeded");
    expect(f.attempt.stripe_reversal_id).toBe(f.reversal.id);
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("does not create another reversal after an external raw reversal on a settled refund", async () => {
    const f = fixture(true);
    f.attempt.status = "succeeded";
    f.attempt.stripe_refund_id = f.refund.id;
    f.attempt.reversal_status = "pending";
    f.providerReversals.push({ ...f.reversal, id: "trr_external", amount: 5000,
      metadata: { platform_refund_attempt: "other", platform_refund_id: f.refund.id } });
    await expect(runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input))
      .rejects.toThrow(/unreserved provider recovery/);
    expect(f.stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(f.attempt.reversal_status).toBe("pending");
  });

  it("releases a conclusively failed provider refund without settling the recipient", async () => {
    const f = fixture();
    f.stripe.refunds.create.mockResolvedValueOnce({ ...f.refund, status: "failed" });
    const result = await runReservedPlatformMoneyRefund(f.stripe as never, f.db as never, f.input);
    expect(result.status).toBe("failed");
    expect(f.attempt.status).toBe("failed");
    expect(f.rpc.mock.calls.some(([name]) => name === "finish_platform_money_refund")).toBe(false);
  });
});
