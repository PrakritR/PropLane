/**
 * Mark done books the vendor's cost as an expense. The booked figure is the accepted bid's, read on the server
 * exactly as approve-and-pay reads it; a client-sent `vendorCostCents` only stands in when no bid was accepted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createExpensesFromWorkOrder: vi.fn(async (..._args: unknown[]) => ["exp-1"]),
  bids: [] as Array<Record<string, unknown>>,
  bidError: null as null | { message: string },
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
});

describe("Mark done trusts the accepted bid, not the browser", () => {
  it("books the accepted bid's labour, materials and vendor when the client sends different numbers", async () => {
    mocks.bids = [{ amount_cents: 25000, materials_cents: 3000, vendor_directory_id: "vendor-bid" }];
    const res = await post({ ...base, vendorCostCents: 1, materialsCostCents: 1 });
    expect(res.status).toBe(200);
    expect(mocks.createExpensesFromWorkOrder.mock.calls[0]![2]).toMatchObject({
      vendorCostCents: 25000,
      materialsCostCents: 3000,
      vendorId: "vendor-bid",
    });
    expect((await res.json()).workOrder).toMatchObject({ vendorCostCents: 25000, materialsCostCents: 3000 });
  });

  it("still takes the client's figure for a directly-assigned job with no accepted bid", async () => {
    await post({ ...base, vendorCostCents: 12000, materialsCostCents: 500 });
    expect(mocks.createExpensesFromWorkOrder.mock.calls[0]![2]).toMatchObject({
      vendorCostCents: 12000,
      materialsCostCents: 500,
      vendorId: "vendor-client",
    });
  });

  it("refuses rather than guess when it cannot read the bid, or when two bids are marked accepted", async () => {
    mocks.bidError = { message: "boom" };
    expect((await post({ ...base, vendorCostCents: 1 })).status).toBe(500);
    mocks.bidError = null;
    mocks.bids = [{ amount_cents: 100 }, { amount_cents: 200 }];
    expect((await post({ ...base, vendorCostCents: 1 })).status).toBe(409);
    expect(mocks.createExpensesFromWorkOrder).not.toHaveBeenCalled();
  });
});
