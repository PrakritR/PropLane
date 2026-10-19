import { describe, expect, it, vi } from "vitest";
import { fakeOwnerDb } from "../helpers/owner-fake-db";

vi.mock("@/lib/owner-management/alerts.server", () => ({ alertManagerOfOwnerEvent: vi.fn(async () => true) }));

import { applyManagedDispute, applyManagedRefund, disputePhase, pickRefundAllocation } from "@/lib/managed-finance/adjustments.server";
import { alertManagerOfOwnerEvent } from "@/lib/owner-management/alerts.server";

const alloc = (id: string, chargeId: string) => ({ id, charge_id: chargeId, workspace_id: "ws-1", stripe_charge_id: "ch_1", principal_cents: 100_000, refunded_principal_cents: 0 });
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_1", amount: 25_000, created: 1_790_000_000, status: "succeeded", metadata: { proplane_charge_id: "c1" }, ...over }) as never;

describe("pickRefundAllocation", () => {
  it("uses the charge named on the refund, else the only allocation", () => {
    expect(pickRefundAllocation([alloc("a", "c1"), alloc("b", "c2")], "c2")?.id).toBe("b");
    expect(pickRefundAllocation([alloc("a", "c1")], null)?.id).toBe("a");
  });
  it("refuses to guess between several, and for an unknown name", () => {
    expect(pickRefundAllocation([alloc("a", "c1"), alloc("b", "c2")], null)).toBeNull();
    expect(pickRefundAllocation([alloc("a", "c1")], "zzz")).toBeNull();
    expect(pickRefundAllocation([], "c1")).toBeNull();
  });
});

describe("applyManagedRefund", () => {
  it("is a no-op (false) for a charge that was never allocated to a managed workspace", async () => {
    const f = fakeOwnerDb({ managed_rent_allocations: [] });
    expect(await applyManagedRefund(f.db, refund(), "ch_1")).toBe(false);
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("reverses a succeeded refund once, keyed on the refund id", async () => {
    const f = fakeOwnerDb({ managed_rent_allocations: [alloc("a1", "c1")] }, { rpc: { apply_managed_refund: () => ({ status: "created" }) } });
    expect(await applyManagedRefund(f.db, refund(), "ch_1")).toBe(true);
    expect(f.rpcCalls[0]).toMatchObject({ name: "apply_managed_refund", args: { p_alloc: "a1", p_refund: "re_1", p_amount: 25_000 } });
  });
  it("a replay is accepted ('exists'), a pending refund posts nothing yet", async () => {
    const f = fakeOwnerDb({ managed_rent_allocations: [alloc("a1", "c1")] }, { rpc: { apply_managed_refund: () => ({ status: "exists" }) } });
    expect(await applyManagedRefund(f.db, refund(), "ch_1")).toBe(true);
    const g = fakeOwnerDb({ managed_rent_allocations: [alloc("a1", "c1")] }, { rpc: { apply_managed_refund: () => ({ status: "created" }) } });
    expect(await applyManagedRefund(g.db, refund({ status: "pending" }), "ch_1")).toBe(true);
    expect(g.rpcCalls).toHaveLength(0);
  });
  it("throws (so the delivery is retried and filed) when the refund cannot be matched or the database refuses", async () => {
    const f = fakeOwnerDb({ managed_rent_allocations: [alloc("a1", "c1"), alloc("a2", "c2")] }, { rpc: { apply_managed_refund: () => ({ status: "created" }) } });
    await expect(applyManagedRefund(f.db, refund({ metadata: {} }), "ch_1")).rejects.toThrow(/needs review/);
    const g = fakeOwnerDb({ managed_rent_allocations: [alloc("a1", "c1")] }, { rpc: { apply_managed_refund: () => ({ status: "refused", reason: "refund_exceeds_payment" }) } });
    await expect(applyManagedRefund(g.db, refund(), "ch_1")).rejects.toThrow(/refund_exceeds_payment/);
  });
  it("a database without the table is simply not managed", async () => {
    const f = fakeOwnerDb({}, { broken: ["managed_rent_allocations"] });
    expect(await applyManagedRefund(f.db, refund(), "ch_1")).toBe(false);
  });
});

describe("disputes", () => {
  it("maps Stripe's dispute status to a ledger phase", () => {
    expect(disputePhase("needs_response")).toBe("opened");
    expect(disputePhase("under_review")).toBe("opened");
    expect(disputePhase("won")).toBe("won");
    expect(disputePhase("warning_closed")).toBe("won");
    expect(disputePhase("charge_refunded")).toBe("won");
    expect(disputePhase("lost")).toBe("lost");
  });
  const dispute = (status: string) => ({ id: "dp_1", payment_intent: "pi_1", amount: 100_000, status, balance_transactions: [] }) as never;
  function setup(rpc: (args: Record<string, unknown>) => unknown) {
    return fakeOwnerDb(
      { managed_rent_allocations: [{ id: "a1", workspace_id: "ws-1", stripe_payment_intent_id: "pi_1" }], portal_workspaces: [{ id: "ws-1", owner_user_id: "mgr" }] },
      { rpc: { apply_managed_dispute: rpc } },
    );
  }
  it("is a no-op for a PaymentIntent that was never allocated", async () => {
    const f = fakeOwnerDb({ managed_rent_allocations: [] }, { rpc: { apply_managed_dispute: () => ({ status: "created" }) } });
    expect(await applyManagedDispute(f.db, dispute("needs_response"))).toBe(false);
  });
  it("opens first, then closes: a lost dispute posts opened then lost with the dispute fee", async () => {
    const f = setup(() => ({ status: "created" }));
    expect(await applyManagedDispute(f.db, dispute("lost"))).toBe(true);
    expect(f.rpcCalls.map((c) => c.args.p_phase)).toEqual(["opened", "lost"]);
    expect(f.rpcCalls[1]!.args.p_dispute_fee).toBe(1500);
  });
  it("uses Stripe's reported dispute fee when it is on the dispute", async () => {
    const f = setup(() => ({ status: "created" }));
    await applyManagedDispute(f.db, { id: "dp_2", payment_intent: "pi_1", amount: 5000, status: "lost", balance_transactions: [{ fee: 2000 }] } as never);
    expect(f.rpcCalls[1]!.args.p_dispute_fee).toBe(2000);
  });
  it("a won dispute releases and tells the manager", async () => {
    const f = setup(() => ({ status: "created" }));
    await applyManagedDispute(f.db, dispute("won"));
    expect(f.rpcCalls.map((c) => c.args.p_phase)).toEqual(["opened", "won"]);
    expect(vi.mocked(alertManagerOfOwnerEvent)).toHaveBeenCalled();
  });
  it("a refusal throws so the delivery retries", async () => {
    const f = setup(() => ({ status: "refused", reason: "dispute_not_opened" }));
    await expect(applyManagedDispute(f.db, dispute("lost"))).rejects.toThrow(/dispute_not_opened/);
  });
});
