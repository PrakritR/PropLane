/**
 * Mark done records the job's costs on the service. The recorded figure is the accepted bid's, read on the server
 * exactly as approve-and-pay reads it; a client-sent `vendorCostCents` only stands in when no bid was accepted.
 * No expense is booked at completion: a cash expense is booked only when a verified payment settles, through the
 * idempotent paid-expense RPC (see approve-and-pay), so Mark done is not a money move.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createExpensesFromWorkOrder: vi.fn(async (..._args: unknown[]) => ["exp-1"]),
  bids: [] as Array<Record<string, unknown>>,
  bidError: null as null | { message: string },
  completePatches: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: async () => undefined }));
vi.mock("@/lib/work-order-expenses", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/work-order-expenses")>()),
  createExpensesFromWorkOrder: mocks.createExpensesFromWorkOrder,
}));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => ({
    userId: "mgr-1",
    email: "m@example.com",
    role: "manager",
    db: {
      // The database locks the service row and merges only completion facts (migration 20261004220000).
      async rpc(name: string, args: { p_patch: Record<string, unknown> }) {
        if (name !== "complete_work_order_record") throw new Error(`unexpected rpc ${name}`);
        mocks.completePatches.push(args.p_patch);
        return { data: { id: "wo-1", ...args.p_patch, completedAt: "2026-10-05T00:00:00.000Z" }, error: null };
      },
      from(table: string) {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: table === "portal_work_order_records" ? { manager_user_id: "mgr-1", row_data: {} } : null, error: null }),
          upsert: async () => ({ error: null }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: table === "work_order_bids" ? mocks.bids : [], error: table === "work_order_bids" ? mocks.bidError : null }).then(resolve),
        };
        return builder;
      },
    },
  }),
  assertManagerFinancialsAccess: async () => ({ ok: true }),
}));

import { POST as markDone } from "@/app/api/portal/work-orders/complete/route";

const post = (body: Record<string, unknown>) =>
  markDone(new Request("http://localhost/api/portal/work-orders/complete", { method: "POST", body: JSON.stringify(body) }));

const base = { workOrder: { id: "wo-1", title: "Leak", propertyId: "prop-a", vendorId: "vendor-client" }, category: "plumbing", skipResidentNotify: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bids = [];
  mocks.bidError = null;
  mocks.completePatches = [];
});

describe("Mark done trusts the accepted bid, not the browser", () => {
  it("records the accepted bid's labour and materials when the client sends different numbers, and books no expense", async () => {
    mocks.bids = [{ amount_cents: 25000, materials_cents: 3000, vendor_directory_id: "vendor-bid" }];
    const res = await post({ ...base, vendorCostCents: 1, materialsCostCents: 1 });
    expect(res.status).toBe(200);
    expect(mocks.completePatches[0]).toMatchObject({ vendorCostCents: 25000, materialsCostCents: 3000 });
    expect((await res.json()).workOrder).toMatchObject({ vendorCostCents: 25000, materialsCostCents: 3000 });
    expect(mocks.createExpensesFromWorkOrder).not.toHaveBeenCalled();
  });

  it("still takes the client's figure for a directly-assigned job with no accepted bid", async () => {
    await post({ ...base, vendorCostCents: 12000, materialsCostCents: 500 });
    expect(mocks.completePatches[0]).toMatchObject({ vendorCostCents: 12000, materialsCostCents: 500 });
    expect(mocks.createExpensesFromWorkOrder).not.toHaveBeenCalled();
  });

  it("never lets the browser choose identity: the completion patch carries no owner, vendor or property", async () => {
    mocks.bids = [{ amount_cents: 25000, vendor_directory_id: "vendor-bid" }];
    await post({ ...base, vendorCostCents: 1 });
    expect(Object.keys(mocks.completePatches[0]!)).not.toEqual(expect.arrayContaining(["vendorId"]));
    expect(mocks.completePatches[0]).not.toHaveProperty("propertyId");
    expect(mocks.completePatches[0]).not.toHaveProperty("managerUserId");
  });

  it("refuses rather than guess when it cannot read the bid, or when two bids are marked accepted", async () => {
    mocks.bidError = { message: "boom" };
    expect((await post({ ...base, vendorCostCents: 1 })).status).toBe(500);
    mocks.bidError = null;
    mocks.bids = [{ amount_cents: 100 }, { amount_cents: 200 }];
    expect((await post({ ...base, vendorCostCents: 1 })).status).toBe(409);
    expect(mocks.createExpensesFromWorkOrder).not.toHaveBeenCalled();
    expect(mocks.completePatches).toEqual([]);
  });
});
