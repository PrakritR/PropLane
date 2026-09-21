import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { POST } from "@/app/api/portal/work-orders/set-vendor-price/route";

type WorkOrderRow = {
  manager_user_id: string;
  vendor_user_id: string;
  row_data: Record<string, unknown>;
};

type BidRow = { id: string; status: string; amount_cents: number; materials_cents: number };

/**
 * `readSnapshot` lets a test simulate a race: the SELECT can return a stale status
 * (e.g. "submitted") while `bid`'s true current status (e.g. "accepted", set by a
 * concurrent manager accept) is what the UPDATE's WHERE-clause filters are checked
 * against below — matching how a real Postgres compare-and-swap UPDATE behaves.
 */
function mockDb(workOrder: WorkOrderRow, bid: BidRow | null, readSnapshot?: Partial<BidRow>) {
  const workOrderUpdates: Record<string, unknown>[] = [];
  const bidUpdates: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "v@test.com", role: "vendor" } }) }) }),
        };
      }
      if (table === "portal_work_order_records") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: workOrder, error: null }) }) }),
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              workOrderUpdates.push(row);
              return { error: null };
            },
          }),
        };
      }
      if (table === "work_order_bids") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: bid ? { ...bid, ...readSnapshot } : null, error: null }),
              }),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq(col: string, val: unknown) {
                filters[col] = val;
                return builder;
              },
              then(resolve: (v: { error: null }) => void) {
                const matches = bid != null && Object.entries(filters).every(([k, v]) => (bid as Record<string, unknown>)[k] === v);
                if (matches) {
                  bidUpdates.push(row);
                  Object.assign(bid!, row);
                }
                resolve({ error: null });
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, workOrderUpdates, bidUpdates };
}

function asVendor(userId = "vendor-1") {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId, user_metadata: {} } } }) },
  } as never);
}

describe("POST /api/portal/work-orders/set-vendor-price", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses to change the amount on an already-accepted bid, and leaves it untouched", async () => {
    asVendor("vendor-1");
    const workOrder: WorkOrderRow = {
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-1",
      row_data: { bucket: "scheduled", vendorCostCents: 40000, cost: "$400.00" },
    };
    const bid: BidRow = { id: "bid-1", status: "accepted", amount_cents: 40000, materials_cents: 0 };
    const { client, workOrderUpdates, bidUpdates } = mockDb(workOrder, bid);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t", { method: "POST", body: { workOrderId: "WO-1", amountCents: 49900 } }),
    );
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);

    expect(status).toBe(409);
    expect(data.error).toBeTruthy();
    expect(bid.amount_cents).toBe(40000);
    expect(bidUpdates).toHaveLength(0);
    expect(workOrderUpdates).toHaveLength(0);
  });

  it("still allows setting a price when no formal bid was ever accepted", async () => {
    asVendor("vendor-1");
    const workOrder: WorkOrderRow = {
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-1",
      row_data: { bucket: "scheduled" },
    };
    const { client, workOrderUpdates } = mockDb(workOrder, null);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t", { method: "POST", body: { workOrderId: "WO-2", amountCents: 40000 } }),
    );
    const { status } = await parseJsonResponse(res);

    expect(status).toBe(200);
    expect(workOrderUpdates).toHaveLength(1);
    expect((workOrderUpdates[0]!.row_data as Record<string, unknown>).vendorCostCents).toBe(40000);
  });

  it("still allows updating the amount on a submitted (not yet accepted) bid", async () => {
    asVendor("vendor-1");
    const workOrder: WorkOrderRow = {
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-1",
      row_data: { bucket: "scheduled" },
    };
    const bid: BidRow = { id: "bid-2", status: "submitted", amount_cents: 30000, materials_cents: 0 };
    const { client, bidUpdates } = mockDb(workOrder, bid);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t", { method: "POST", body: { workOrderId: "WO-3", amountCents: 35000 } }),
    );
    const { status } = await parseJsonResponse(res);

    expect(status).toBe(200);
    expect(bidUpdates).toHaveLength(1);
    expect(bid.amount_cents).toBe(35000);
  });

  it("does not let a stale-read request overwrite a bid the manager accepted in the race window between read and write", async () => {
    asVendor("vendor-1");
    const workOrder: WorkOrderRow = {
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-1",
      row_data: { bucket: "scheduled" },
    };
    // Manager's concurrent accept has already committed status: "accepted" by the time
    // the UPDATE runs, even though this request's earlier SELECT still observed "submitted".
    const bid: BidRow = { id: "bid-4", status: "accepted", amount_cents: 40000, materials_cents: 0 };
    const { client, bidUpdates } = mockDb(workOrder, bid, { status: "submitted" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t", { method: "POST", body: { workOrderId: "WO-4", amountCents: 49900 } }),
    );
    const { status } = await parseJsonResponse(res);

    expect(status).toBe(200);
    expect(bidUpdates).toHaveLength(0);
    expect(bid.amount_cents).toBe(40000);
  });
});
