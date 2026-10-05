import { beforeEach, describe, expect, it, vi } from "vitest";

const classified = vi.hoisted(() => vi.fn());
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: classified,
}));
import { handleStripeTransferCreated, handleStripeTransferReversed } from "@/lib/stripe-webhook-financials";

function fixture(mode: "destination" | "hold" = "hold") {
  const hold = { id: "hold-1", owner_user_id: "owner", status: mode === "hold" ? "held" : "transferred",
    source_allocation_mode: mode, source_verified_at: "2026-10-04T00:00:00Z",
    stripe_charge_id: "ch_source", stripe_transfer_id: mode === "hold" ? null : "tr_source",
    source_transfer_gross_cents: mode === "hold" ? null : 5175,
    source_destination_account_id: mode === "hold" ? null : "acct_owned" };
  const transferAttempt = { id: "attempt-1", hold_id: hold.id, attempt_key: "hold:one",
    owner_user_id: "owner", destination_account_id: "acct_owned", source_charge_id: "ch_source",
    amount_cents: 5000, status: "reserved", stripe_transfer_id: null };
  const refundAttempt = { id: "refund-attempt-1", hold_id: hold.id, attempt_key: "refund:one",
    source_charge_id: "ch_source", stripe_refund_id: "re_exact", hold_debit_cents: 2500 };
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const from = vi.fn((table: string) => {
    const query: Record<string, unknown> = {
      eq: () => query,
      limit: vi.fn(async () => ({ data: table === "platform_payment_holds" ? [hold] : [], error: null })),
      maybeSingle: vi.fn(async () => ({ data: table === "platform_hold_transfer_attempts"
        ? transferAttempt : table === "platform_hold_refund_attempts" ? refundAttempt : null,
      error: null })),
    };
    return { select: () => query };
  });
  const transfer = { id: "tr_source", source_transaction: "ch_source", destination: "acct_owned",
    amount: mode === "hold" ? 5000 : 5175, currency: "usd",
    metadata: mode === "hold" ? { platform_hold_id: hold.id,
      platform_hold_attempt: transferAttempt.id } : {} };
  return { db: { from, rpc }, from, rpc, hold, transferAttempt, refundAttempt, transfer };
}

describe("exact platform transfer webhook reconciliation", () => {
  beforeEach(() => { vi.clearAllMocks(); classified.mockResolvedValue({ captured: false }); });

  it("finalizes an early hold-release event by exact attempt without editing payment net", async () => {
    const f = fixture();
    await handleStripeTransferCreated(f.db as never, f.transfer as never);
    expect(f.rpc).toHaveBeenCalledWith("finish_platform_hold_transfer", {
      p_hold: "hold-1", p_owner: "owner", p_attempt: "hold:one", p_transfer: "tr_source",
    });
    expect(f.from).not.toHaveBeenCalledWith("ledger_entries");
  });

  it("accepts a delayed destination transfer's payer gross without overwriting recipient net", async () => {
    const f = fixture("destination");
    await handleStripeTransferCreated(f.db as never, f.transfer as never);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.from).not.toHaveBeenCalledWith("ledger_entries");
    await expect(handleStripeTransferCreated(f.db as never,
      { ...f.transfer, amount: 5000 } as never)).rejects.toThrow(/matching captured destination/);
    f.hold.status = "refunded";
    await expect(handleStripeTransferCreated(f.db as never, f.transfer as never)).resolves.toBeUndefined();
  });

  it("rejects unrelated release metadata or failed finish instead of acknowledging", async () => {
    const wrong = fixture();
    await expect(handleStripeTransferCreated(wrong.db as never,
      { ...wrong.transfer, metadata: { ...wrong.transfer.metadata,
        platform_hold_attempt: "another-attempt" } } as never))
      .rejects.toThrow(/reserved hold release/);
    const failed = fixture();
    failed.rpc.mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } });
    await expect(handleStripeTransferCreated(failed.db as never, failed.transfer as never))
      .rejects.toThrow(/finalize exact recipient transfer/);
  });

  it("settles an exact partial reversal while retaining the original transfer identity", async () => {
    const f = fixture("destination");
    const reversal = { id: "trr_exact", amount: 2500, transfer: "tr_source", source_refund: null,
      metadata: { platform_refund_attempt: "refund-attempt-1", platform_refund_id: "re_exact" } };
    await handleStripeTransferReversed(f.db as never, {
      ...f.transfer, amount_reversed: 2500,
      reversals: { data: [reversal], has_more: false },
    } as never);
    expect(f.rpc).toHaveBeenCalledWith("finish_platform_transfer_reversal", {
      p_attempt: "refund:one", p_source_transfer: "tr_source",
      p_reversal: "trr_exact", p_amount: 2500,
    });
    expect(f.from).not.toHaveBeenCalledWith("ledger_entries");
    await expect(handleStripeTransferReversed(f.db as never, {
      ...f.transfer, amount_reversed: 2500,
      reversals: { data: [{ ...reversal, transfer: "tr_other" }], has_more: false },
    } as never)).rejects.toThrow(/no exact refund reservation/);
  });

  it("fails unmapped or incomplete provider reversals without clearing ledger links", async () => {
    const f = fixture("destination");
    await expect(handleStripeTransferReversed(f.db as never, {
      ...f.transfer, amount_reversed: 2500,
      reversals: { data: [{ id: "trr_unknown", amount: 2500, metadata: {} }], has_more: false },
    } as never)).rejects.toThrow(/no exact refund reservation/);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.from).not.toHaveBeenCalledWith("ledger_entries");
  });
});
