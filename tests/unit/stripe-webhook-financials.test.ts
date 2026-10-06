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
      source_allocation_mode: "hold", stripe_transfer_id: "tr_other",
      source_verified_at: "2026-10-01T00:00:00Z" }]);
    await expect(handleStripeTransferReversed(db as never, transfer as never))
      .rejects.toThrow(/does not match one verified allocation/);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous allocation before reading either row", async () => {
    const { db } = dbReturning([{ id: "h1" }, { id: "h2" }]);
    await expect(handleStripeTransferReversed(db as never, transfer as never))
      .rejects.toThrow(/does not match one verified allocation/);
  });

  /**
   * Only a central capture reverses through a reservation. A destination charge
   * refunded with `reverse_transfer: true` emits an auto-generated reversal with no
   * metadata; throwing here would 500 every Stripe retry and risk the endpoint.
   */
  it("passes over a destination-allocation reversal without failing the event", async () => {
    const { db, update } = dbReturning([{ id: "h1", owner_user_id: "o1", stripe_charge_id: "ch_test_1",
      source_allocation_mode: "destination", stripe_transfer_id: "tr_other",
      source_verified_at: "2026-10-01T00:00:00Z" }]);
    await expect(handleStripeTransferReversed(db as never, transfer as never)).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("passes over a pre-arbitration hold with no allocation mode", async () => {
    const { db, update } = dbReturning([{ id: "h1", owner_user_id: "o1", stripe_charge_id: "ch_test_1",
      source_allocation_mode: null, stripe_transfer_id: "tr_reversed_1", source_verified_at: null }]);
    await expect(handleStripeTransferReversed(db as never, transfer as never)).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
