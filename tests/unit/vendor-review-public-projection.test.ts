import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vendor-facing review routes must never return an identity column —
 * `vendor_reviews` grants no direct client SELECT at all (RLS is
 * policy-less on this table since
 * 20260925010000_vendor_reviews_no_client_select.sql), and the app-level
 * routes are the only read path, so they must actually project down to the
 * safe columns rather than leaking `manager_user_id` / `reviewer_user_id` /
 * `work_order_id` (or their camelCase client shapes) through the JSON body.
 * The UI says "A PropLane manager" for a reason — the API must not know
 * better.
 */

type Row = Record<string, unknown>;

const FORBIDDEN_KEYS = [
  "managerUserId",
  "vendorUserId",
  "reviewerUserId",
  "workOrderId",
  "manager_user_id",
  "vendor_user_id",
  "reviewer_user_id",
  "work_order_id",
];

function assertNoIdentityLeak(review: Row) {
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(review, key), `leaked "${key}"`).toBe(false);
  }
}

function makeFakeDb(rows: Row[]) {
  function builder() {
    const filters: [string, unknown][] = [];
    let mode: "select" | "update" = "select";
    let patch: Row | null = null;
    let selectedColumns: string[] | null = null;

    const project = (row: Row) => {
      if (!selectedColumns) return { ...row };
      const out: Row = {};
      for (const col of selectedColumns) out[col] = row[col];
      return out;
    };

    const matched = () => rows.filter((r) => filters.every(([col, val]) => r[col] === val));

    const api = {
      select(columns?: string) {
        selectedColumns = columns ? columns.split(",").map((c) => c.trim()) : null;
        return api;
      },
      update(vals: Row) {
        mode = "update";
        patch = vals;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      order() {
        return api;
      },
      async maybeSingle() {
        const hit = matched()[0] ?? null;
        if (mode === "update" && hit && patch) Object.assign(hit, patch);
        return { data: hit ? project(hit) : null, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        // Support `await query` (GET's list read never calls maybeSingle()).
        return Promise.resolve({ data: matched().map(project), error: null }).then(resolve);
      },
    };
    return api;
  }
  return { from: () => builder() };
}

const state = vi.hoisted(() => ({
  rows: [] as Row[],
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeFakeDb(state.rows),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: async () => ({ ok: true, userId: VENDOR_ID }),
}));

const VENDOR_ID = "vendor-1";
const MANAGER_ID = "manager-1";
const REVIEWER_ID = "manager-1";
const REVIEW_ID = "review-1";

function reviewRow(over: Row = {}): Row {
  return {
    id: REVIEW_ID,
    manager_user_id: MANAGER_ID,
    reviewer_user_id: REVIEWER_ID,
    vendor_user_id: VENDOR_ID,
    work_order_id: "wo-1",
    stars: 5,
    body: "Great work.",
    vendor_reply: null,
    vendor_replied_at: null,
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
    ...over,
  };
}

describe("vendor-facing review routes never leak an identity column", () => {
  beforeEach(() => {
    vi.resetModules();
    state.rows = [reviewRow()];
  });

  it("GET /api/vendor/reviews returns only the safe projection", async () => {
    const { GET } = await import("@/app/api/vendor/reviews/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { reviews: Row[] };
    expect(data.reviews).toHaveLength(1);
    const review = data.reviews[0]!;
    assertNoIdentityLeak(review);
    expect(review.reviewerLabel).toBe("A PropLane manager");
    expect(review.stars).toBe(5);
    expect(review.body).toBe("Great work.");
  });

  it("POST /api/vendor/reviews/[id]/reply returns only the safe projection", async () => {
    const { POST } = await import("@/app/api/vendor/reviews/[id]/reply/route");
    const req = new Request("http://test/api/vendor/reviews/review-1/reply", {
      method: "POST",
      body: JSON.stringify({ reply: "Thanks for the kind words!" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: REVIEW_ID }) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { review: Row };
    assertNoIdentityLeak(data.review);
    expect(data.review.vendorReply).toBe("Thanks for the kind words!");
    expect(data.review.reviewerLabel).toBe("A PropLane manager");
  });
});
