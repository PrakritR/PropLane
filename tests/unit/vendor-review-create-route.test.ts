import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level coverage for POST /api/portal/vendor-reviews: the manager
 * create route must refuse a second review of the same completed service
 * (409, backed by the migration's `unique (work_order_id)`), and accept a
 * first review for a completed, vendor-linked work order owned by the
 * calling manager. Runs the real handler against in-memory
 * portal_work_order_records + vendor_reviews fakes.
 */

type Row = Record<string, unknown>;

const MANAGER_ID = "manager_a";
const VENDOR_ID = "vendor_a";
const WORK_ORDER_ID = "wo-1";

function makeFakeDb(workOrders: Row[], reviews: Row[], bids: Row[] = []) {
  function reviewsTable() {
    const filters: [string, unknown][] = [];
    let pendingInsert: Row | null = null;
    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      order() {
        return api;
      },
      insert(values: Row) {
        pendingInsert = values;
        return api;
      },
      async maybeSingle() {
        const row = reviews.find((r) => filters.every(([col, val]) => r[col] === val)) ?? null;
        return { data: row, error: null };
      },
      async single() {
        if (pendingInsert) {
          const duplicate = reviews.some((r) => r.work_order_id === pendingInsert!.work_order_id);
          if (duplicate) {
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
          const row = { id: `review-${reviews.length + 1}`, ...pendingInsert };
          reviews.push(row);
          return { data: row, error: null };
        }
        return { data: null, error: { message: "not found" } };
      },
    };
    return api;
  }

  function workOrdersTable() {
    const filters: [string, unknown][] = [];
    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      async maybeSingle() {
        const row = workOrders.find((r) => filters.every(([col, val]) => r[col] === val)) ?? null;
        return { data: row, error: null };
      },
    };
    return api;
  }

  function bidsTable() {
    const filters: [string, unknown][] = [];
    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      then(resolve: (value: unknown) => unknown) {
        const count = bids.filter((r) => filters.every(([col, val]) => r[col] === val)).length;
        return Promise.resolve({ count, error: null }).then(resolve);
      },
    };
    return api;
  }

  return {
    from(table: string) {
      if (table === "work_order_bids") return bidsTable();
      if (table === "vendor_reviews") return reviewsTable();
      if (table === "portal_work_order_records") return workOrdersTable();
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const state = vi.hoisted(() => ({
  auth: null as { db: unknown; userId: string; role: string } | null,
}));

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => state.auth,
}));

vi.mock("@/lib/vendor-review-write-access.server", () => ({
  canActForVendorReviewWorkspace: async (_db: unknown, actorUserId: string, ownerManagerUserId: string) =>
    actorUserId === ownerManagerUserId,
}));

function completedWorkOrderRow(extra: Row = {}): Row {
  return {
    manager_user_id: MANAGER_ID,
    vendor_user_id: VENDOR_ID,
    property_id: "prop-1",
    assigned_property_id: null,
    row_data: { bucket: "completed" },
    ...extra,
  };
}

describe("POST /api/portal/vendor-reviews", () => {
  let workOrders: Row[];
  let reviews: Row[];
  let bids: Row[];

  beforeEach(async () => {
    workOrders = [{ id: WORK_ORDER_ID, ...completedWorkOrderRow() }];
    reviews = [];
    bids = [];
    state.auth = { db: makeFakeDb(workOrders, reviews, bids), userId: MANAGER_ID, role: "manager" };
    vi.resetModules();
  });

  it("creates the first review for a completed, vendor-linked service", async () => {
    const { POST } = await import("@/app/api/portal/vendor-reviews/route");
    const req = new Request("http://test/api/portal/vendor-reviews", {
      method: "POST",
      body: JSON.stringify({ workOrderId: WORK_ORDER_ID, stars: 5, body: "Great work." }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { review: { stars: number; vendorUserId: string } };
    expect(data.review.stars).toBe(5);
    expect(data.review.vendorUserId).toBe(VENDOR_ID);
  });

  it("refuses a second review of the same completed service with 409", async () => {
    const { POST } = await import("@/app/api/portal/vendor-reviews/route");
    const body = JSON.stringify({ workOrderId: WORK_ORDER_ID, stars: 5, body: "Great work." });
    const first = await POST(new Request("http://test/api/portal/vendor-reviews", { method: "POST", body }));
    expect(first.status).toBe(200);

    const second = await POST(new Request("http://test/api/portal/vendor-reviews", { method: "POST", body }));
    expect(second.status).toBe(409);
    const data = (await second.json()) as { error: string };
    expect(data.error).toBe("A review already exists for this service.");
  });

  it("refuses a review of a service that isn't completed", async () => {
    workOrders[0] = { id: WORK_ORDER_ID, ...completedWorkOrderRow({ row_data: { bucket: "scheduled" } }) };
    const { POST } = await import("@/app/api/portal/vendor-reviews/route");
    const res = await POST(
      new Request("http://test/api/portal/vendor-reviews", {
        method: "POST",
        body: JSON.stringify({ workOrderId: WORK_ORDER_ID, stars: 4, body: "" }),
      }),
    );
    expect(res.status).toBe(422);
    expect(reviews).toHaveLength(0);
  });

  it("accepts a review of a not-yet-completed service once the vendor has submitted an estimate", async () => {
    workOrders[0] = { id: WORK_ORDER_ID, ...completedWorkOrderRow({ row_data: { bucket: "scheduled" } }) };
    bids.push({ work_order_id: WORK_ORDER_ID, vendor_user_id: VENDOR_ID, status: "submitted" });
    const { POST } = await import("@/app/api/portal/vendor-reviews/route");
    const res = await POST(
      new Request("http://test/api/portal/vendor-reviews", {
        method: "POST",
        body: JSON.stringify({ workOrderId: WORK_ORDER_ID, stars: 4, body: "" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("ignores an estimate another vendor gave on the same service", async () => {
    workOrders[0] = { id: WORK_ORDER_ID, ...completedWorkOrderRow({ row_data: { bucket: "scheduled" } }) };
    bids.push({ work_order_id: WORK_ORDER_ID, vendor_user_id: "vendor_other", status: "submitted" });
    const { POST } = await import("@/app/api/portal/vendor-reviews/route");
    const res = await POST(
      new Request("http://test/api/portal/vendor-reviews", {
        method: "POST",
        body: JSON.stringify({ workOrderId: WORK_ORDER_ID, stars: 4, body: "" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("refuses when the body names a different vendor than the one on the service", async () => {
    const { POST } = await import("@/app/api/portal/vendor-reviews/route");
    const res = await POST(
      new Request("http://test/api/portal/vendor-reviews", {
        method: "POST",
        body: JSON.stringify({ workOrderId: WORK_ORDER_ID, vendorUserId: "vendor_other", stars: 4, body: "" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(reviews).toHaveLength(0);
  });

  it("refuses a review of a service belonging to a different workspace", async () => {
    workOrders[0] = { id: WORK_ORDER_ID, ...completedWorkOrderRow({ manager_user_id: "manager_other" }) };
    const { POST } = await import("@/app/api/portal/vendor-reviews/route");
    const res = await POST(
      new Request("http://test/api/portal/vendor-reviews", {
        method: "POST",
        body: JSON.stringify({ workOrderId: WORK_ORDER_ID, stars: 4, body: "" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
