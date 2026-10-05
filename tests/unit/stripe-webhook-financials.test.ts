import { describe, expect, it, vi } from "vitest";
import { handleStripeTransferReversed } from "@/lib/stripe-webhook-financials";

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

function dbReturning(allocations: unknown[]) {
  const update = vi.fn();
  const limit = vi.fn().mockResolvedValue({ data: allocations, error: null });
  const select = vi.fn(() => ({ eq: vi.fn(() => ({ limit })) }));
  return { update, rpc: vi.fn(), db: { from: vi.fn(() => ({ select, update })), rpc: vi.fn() } };
}

const transfer = {
  id: "tr_reversed_1", object: "transfer", amount: 1000, amount_reversed: 0, currency: "usd",
  source_transaction: "ch_test_1", reversals: { data: [], has_more: false },
};

describe("handleStripeTransferReversed", () => {
  it("does nothing for a transfer with no source charge", async () => {
    const { db } = dbReturning([]);
    await handleStripeTransferReversed(db as never, { ...transfer, source_transaction: null } as never);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("ignores a transfer that matches no allocation and never rewrites rows", async () => {
    const { db, update } = dbReturning([]);
    await handleStripeTransferReversed(db as never, transfer as never);
    expect(update).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("refuses to settle a reversal that does not match exactly one verified allocation", async () => {
    const { db, update } = dbReturning([{ id: "h1", owner_user_id: "o1", stripe_charge_id: "ch_test_1",
      stripe_transfer_id: "tr_other", source_verified_at: "2026-10-01T00:00:00Z" }]);
    await expect(handleStripeTransferReversed(db as never, transfer as never))
      .rejects.toThrow(/does not match one verified allocation/);
    expect(update).not.toHaveBeenCalled();
  });
});
